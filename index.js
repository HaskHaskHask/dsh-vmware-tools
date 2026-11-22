/**
 * VMware control plugin for DeepSeek Harness.
 *
 * Registers model-facing tools that read and control local VMware
 * Workstation / Player virtual machines through the `vmrun` command-line tool.
 * Read operations (listing, reading settings) also fall back to the VMware
 * inventory and `.vmx` files when `vmrun` cannot start, so the model still gets
 * useful information and a clear explanation of what is unavailable.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'dsh-vmware-tools'
export const inject = ['tools']

/**
 * Raw configuration keys (set in cordis.patch.yml `config`):
 * - vmrunPath:    absolute path to vmrun.exe; auto-detected when empty.
 * - vmrunType:    vmrun -T type — ws (Workstation), player, or fusion. Default ws.
 * - vmDir:        default directory for newly created VMs.
 * - timeoutMs:    per-command timeout in milliseconds. Default 120000.
 * - guestUser:    default guest OS username for in-guest operations.
 * - guestPassword: default guest OS password for in-guest operations.
 */

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// vmrun discovery and execution
// ---------------------------------------------------------------------------

/** Candidate vmrun.exe locations on a Windows host. */
const VMRUN_CANDIDATES = [
  'C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe',
  'C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe',
  'C:\\Program Files (x86)\\VMware\\VMware Player\\vmrun.exe',
  'C:\\Program Files\\VMware\\VMware Player\\vmrun.exe',
  '/Applications/VMware Fusion.app/Contents/Library/vmrun',
]

/**
 * Locate vmrun from the explicit config, an environment variable, common
 * install locations, or the PATH. Returns `'vmrun'` as a final fallback so a
 * later invocation still produces a clear diagnostic.
 */
function detectVmrun(config) {
  if (config.vmrunPath && existsSync(config.vmrunPath)) return config.vmrunPath
  if (process.env.VMWARE_VMRUN && existsSync(process.env.VMWARE_VMRUN)) return process.env.VMWARE_VMRUN
  for (const candidate of VMRUN_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return 'vmrun'
}

/** Find the sibling vmware-vdiskmanager.exe used to create blank disks. */
function detectVdiskmanager(config) {
  const vmrun = detectVmrun(config)
  if (vmrun && vmrun !== 'vmrun') {
    const sibling = join(dirname(vmrun), 'vmware-vdiskmanager.exe')
    if (existsSync(sibling)) return sibling
  }
  return null
}

function joinOutput(stdout, stderr) {
  const out = (stdout ?? '').trim()
  const err = (stderr ?? '').trim()
  if (out && err) return `${out}\n${err}`
  return out || err
}

/**
 * Run vmrun and collect stdout/stderr and the exit code. vmrun reports its own
 * failures on stdout with a negative exit code, so both streams are captured.
 */
async function runVmrun(vmrun, args, { timeout = 120000, signal } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(vmrun, args, {
      timeout,
      signal,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
    return {
      ok: true,
      exitCode: 0,
      output: joinOutput(stdout, stderr),
      stdout: stdout ?? '',
      stderr: stderr ?? '',
    }
  } catch (error) {
    const stdout = (error.stdout ?? '').toString()
    const stderr = (error.stderr ?? '').toString()
    return {
      ok: false,
      exitCode: typeof error.code === 'number' ? error.code : null,
      signal: error.signal ?? null,
      killed: error.killed ?? false,
      output: joinOutput(stdout, stderr),
      stdout,
      stderr,
      message: error.message,
    }
  }
}

/** vmrun with the configured -T type and optional guest credentials prepended. */
async function vmrun(config, args, options, guest) {
  const exe = detectVmrun(config)
  const type = config.vmrunType || 'ws'
  const auth = []
  const user = guest?.guestUser ?? config.guestUser
  const pass = guest?.guestPassword ?? config.guestPassword
  if (user) auth.push('-gu', user)
  if (pass) auth.push('-gp', pass)
  return runVmrun(exe, ['-T', type, ...auth, ...args], options)
}

// ---------------------------------------------------------------------------
// Inventory and .vmx parsing (read-only fallbacks that need no vmrun)
// ---------------------------------------------------------------------------

/** Parse `%APPDATA%\VMware\inventory.vmls` into registered-VM records. */
function readInventory() {
  const appData = process.env.APPDATA
  if (!appData) return null
  const path = join(appData, 'VMware', 'inventory.vmls')
  if (!existsSync(path)) return null
  let content
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const entries = new Map()
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^vmlist(\d+)\.([A-Za-z]+)\s*=\s*"?(.*?)"?\s*$/)
    if (!match) continue
    const [, index, key, value] = match
    if (!entries.has(index)) entries.set(index, {})
    entries.get(index)[key] = value
  }
  const vms = []
  for (const entry of entries.values()) {
    if (!entry.config) continue
    vms.push({
      name: entry.DisplayName || basename(entry.config, '.vmx'),
      path: entry.config,
      state: entry.State || 'unknown',
    })
  }
  return vms
}

/** Parse a `.vmx` file into a key/value object. */
function parseVmx(content) {
  const settings = {}
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9._:]+)\s*=\s*"([^"]*)"\s*$/)
    if (match) {
      settings[match[1]] = match[2]
      continue
    }
    const bare = line.match(/^\s*([A-Za-z0-9._:]+)\s*=\s*(.*?)\s*$/)
    if (bare && !bare[1].startsWith('.')) {
      settings[bare[1]] = bare[2]
    }
  }
  return settings
}

function readVmxSettings(vmxPath) {
  if (!existsSync(vmxPath)) return { ok: false, error: `VMX file not found: ${vmxPath}` }
  try {
    const content = readFileSync(vmxPath, 'utf8')
    return { ok: true, settings: parseVmx(content) }
  } catch (error) {
    return { ok: false, error: `Failed to read VMX file: ${error.message}` }
  }
}

// ---------------------------------------------------------------------------
// Presentation helper
// ---------------------------------------------------------------------------

function renderText(value) {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: renderText(value) }],
}

/** Describe a vmrun failure clearly so the model can explain it to the user. */
function vmrunFailure(result) {
  const hint = result.signal
    ? `vmrun was terminated by signal ${result.signal}.`
    : result.exitCode === null && result.message?.includes('ENOENT')
      ? 'vmrun.exe was not found; set vmrunPath in the plugin config or install VMware Workstation.'
      : `vmrun exited with code ${result.exitCode}.`
  return `vmrun failed: ${hint} Output: ${result.output || '(empty)'}`
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const timeoutMs = config.timeoutMs ?? 120000
  const credentials = credentialsOf(ctx)
  const guestFor = (args) => resolveGuest(credentials, config, args)

  // 1. List virtual machines (registered + running).
  ctx.tools.register({
    name: 'vm_list',
    description:
      'List local VMware virtual machines with their paths, display names, and whether each one is running. ' +
      'Running state comes from vmrun list; the registered set and display names come from the VMware inventory. ' +
      'If vmrun cannot start, running status is reported as null.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: textOutput,
    async execute(_args, exec) {
      // Running VMs come from `vmrun list`.
      const runningResult = await vmrun(config, ['list'], { timeout: timeoutMs, signal: exec.signal })
      const runningOk = runningResult.ok
      const runningPaths = runningOk
        ? runningResult.output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.toLowerCase().endsWith('.vmx'))
        : []
      const runningSet = new Set(runningPaths.map(normalizeKey))

      // Registered VMs come from the VMware inventory (name + path + state).
      const inventory = readInventory() ?? []
      let vms = inventory.map((entry) => ({
        name: entry.name,
        path: entry.path,
        running: runningOk ? runningSet.has(normalizeKey(entry.path)) : null,
        state: entry.state,
      }))

      // If the inventory is empty, fall back to listRegisteredVM where supported.
      if (vms.length === 0) {
        const regResult = await vmrun(config, ['listRegisteredVM'], { timeout: timeoutMs, signal: exec.signal })
        const regPaths = regResult.ok
          ? regResult.output
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.toLowerCase().endsWith('.vmx'))
          : []
        vms = regPaths.map((path) => ({
          name: basename(path, '.vmx'),
          path,
          running: runningOk ? runningSet.has(normalizeKey(path)) : null,
          state: runningOk && runningSet.has(normalizeKey(path)) ? 'running' : 'unknown',
        }))
      }

      // If only running VMs are known, surface them rather than returning empty.
      if (vms.length === 0 && runningPaths.length > 0) {
        vms = runningPaths.map((path) => ({
          name: basename(path, '.vmx'),
          path,
          running: true,
          state: 'running',
        }))
      }

      if (vms.length === 0) {
        return {
          ok: false,
          error: runningOk ? 'No virtual machines found.' : vmrunFailure(runningResult),
          hint: 'No VMs were found in vmrun or the VMware inventory.',
        }
      }

      return {
        ok: true,
        source: inventory.length > 0 ? 'inventory+vmrun' : 'vmrun',
        runningOk,
        count: vms.length,
        runningCount: vms.filter((vm) => vm.running === true).length,
        vms,
      }
    },
  })

  // 2. Read VM settings.
  ctx.tools.register({
    name: 'vm_get_config',
    description:
      'Read configuration settings of one VMware virtual machine. With `keys`, reads only those VMX variables; without `keys`, returns the full parsed .vmx file. Reading works even when vmrun is unavailable.',
    parameters: {
      type: 'object',
      properties: {
        vmx: { type: 'string', description: 'Absolute path to the .vmx file of the virtual machine.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Optional list of VMX variable names to read; omit to read all settings.' },
      },
      required: ['vmx'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args) {
      if (!Array.isArray(args.keys) || args.keys.length === 0) {
        const read = readVmxSettings(args.vmx)
        if (!read.ok) return read
        return { ok: true, source: 'vmx', path: args.vmx, settings: read.settings }
      }
      const read = readVmxSettings(args.vmx)
      const fallback = read.ok ? read.settings : {}
      const settings = {}
      const missing = []
      for (const key of args.keys) {
        if (key in fallback) {
          settings[key] = fallback[key]
        } else {
          missing.push(key)
        }
      }
      return {
        ok: true,
        source: 'vmx',
        path: args.vmx,
        settings,
        missing,
      }
    },
  })

  // 3. Write VM settings.
  ctx.tools.register({
    name: 'vm_set_config',
    description:
      'Write configuration settings of one VMware virtual machine. Each key/value is written as a VMX variable through vmrun. The virtual machine must be powered off for changes to persist.',
    parameters: {
      type: 'object',
      properties: {
        vmx: { type: 'string', description: 'Absolute path to the .vmx file of the virtual machine.' },
        settings: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map of VMX variable names to new values.' },
      },
      required: ['vmx', 'settings'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const keys = Object.keys(args.settings ?? {})
      if (keys.length === 0) return { ok: false, error: 'settings must be a non-empty object' }
      const written = {}
      const failed = {}
      for (const key of keys) {
        const result = await vmrun(config, ['writeVariable', args.vmx, 'runtimeConfig', key, String(args.settings[key])], {
          timeout: timeoutMs,
          signal: exec.signal,
        })
        if (result.ok) {
          written[key] = args.settings[key]
        } else {
          failed[key] = { value: args.settings[key], error: vmrunFailure(result) }
        }
      }
      return {
        ok: Object.keys(failed).length === 0,
        written,
        failed,
        note: 'vmrun writeVariable requires the virtual machine to be powered off.',
      }
    },
  })

  // 4. Create a virtual machine.
  ctx.tools.register({
    name: 'vm_create',
    description:
      'Create a new local VMware virtual machine. Either clone an existing VM (from `cloneFrom`) or create a blank VM with a minimal .vmx file and, when `diskSizeGB` is set, a new virtual disk. Returns the path of the created .vmx.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the new virtual machine.' },
        cloneFrom: { type: 'string', description: 'Optional path to an existing .vmx to clone instead of creating a blank VM.' },
        cloneType: { type: 'string', enum: ['full', 'linked'], description: 'Clone mode; defaults to full.' },
        dir: { type: 'string', description: 'Directory for the new VM; defaults to the plugin vmDir config or ~/Documents/Virtual Machines.' },
        diskSizeGB: { type: 'number', description: 'Optional size in GB for a new blank disk.' },
        guestOS: { type: 'string', description: 'Optional VMware guestOS identifier for the .vmx, e.g. "other-64".' },
        memSizeMB: { type: 'number', description: 'Memory in MB for the blank VM; defaults to 2048.' },
        numVcpus: { type: 'number', description: 'Number of virtual CPUs; defaults to 2.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const name = args.name
      const dir = args.dir || config.vmDir || join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Documents', 'Virtual Machines')

      // Clone path.
      if (args.cloneFrom) {
        const destVmx = join(dir, name, `${name}.vmx`)
        mkdirSync(dirname(destVmx), { recursive: true })
        const cloneType = args.cloneType || 'full'
        const result = await vmrun(config, ['clone', args.cloneFrom, destVmx, cloneType, ...(name ? [`-cloneName=${name}`] : [])], {
          timeout: Math.max(timeoutMs, 300000),
          signal: exec.signal,
        })
        if (!result.ok) return { ok: false, error: vmrunFailure(result) }
        return { ok: true, created: 'clone', name, path: destVmx }
      }

      // Blank VM.
      const vmDir = join(dir, name)
      mkdirSync(vmDir, { recursive: true })
      const vmxPath = join(vmDir, `${name}.vmx`)
      if (existsSync(vmxPath)) return { ok: false, error: `A VM already exists at ${vmxPath}` }

      let diskFile = `${name}.vmdk`
      if (args.diskSizeGB) {
        const vdiskmanager = detectVdiskmanager(config)
        if (!vdiskmanager) {
          return { ok: false, error: 'vmware-vdiskmanager.exe was not found next to vmrun; create the disk manually or clone an existing VM.' }
        }
        const diskPath = join(vmDir, `${name}.vmdk`)
        const sizeArg = `${Math.max(1, args.diskSizeGB)}GB`
        const result = await runVmrun(vdiskmanager, ['-c', '-s', sizeArg, '-a', 'scsi', '-t', '0', diskPath], {
          timeout: Math.max(timeoutMs, 300000),
          signal: exec.signal,
        })
        if (!result.ok) return { ok: false, error: `Failed to create virtual disk: ${vmrunFailure(result)}` }
      }

      const lines = [
        '.encoding = "windows-1252"',
        'config.version = "8"',
        'virtualHW.version = "19"',
        `displayName = "${name}"`,
        `guestOS = "${args.guestOS || 'other-64'}"`,
        `memsize = "${args.memSizeMB || 2048}"`,
        `numvcpus = "${args.numVcpus || 2}"`,
        'scsi0.present = "TRUE"',
        'scsi0.virtualDev = "lsilogic"',
        'scsi0:0.present = "TRUE"',
        `scsi0:0.fileName = "${diskFile}"`,
        'ethernet0.present = "TRUE"',
        'ethernet0.connectionType = "nat"',
        'ethernet0.virtualDev = "e1000e"',
        'ethernet0.wakeOnPcktRcv = "FALSE"',
        'ethernet0.addressType = "generated"',
        '',
      ]
      writeFileSync(vmxPath, lines.join('\n'), 'utf8')
      return {
        ok: true,
        created: 'blank',
        name,
        path: vmxPath,
        note: 'A blank VM was created. It has no operating system; attach installation media in VMware Workstation to boot it.',
      }
    },
  })

  // 5. Delete a virtual machine.
  ctx.tools.register({
    name: 'vm_delete',
    description:
      'Delete a local VMware virtual machine from the inventory and remove its files. This is destructive and cannot be undone; verify the .vmx path first.',
    parameters: {
      type: 'object',
      properties: {
        vmx: { type: 'string', description: 'Absolute path to the .vmx file of the virtual machine to delete.' },
      },
      required: ['vmx'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const result = await vmrun(config, ['deleteVM', args.vmx], { timeout: timeoutMs, signal: exec.signal })
      if (!result.ok) return { ok: false, error: vmrunFailure(result) }
      return { ok: true, deleted: args.vmx }
    },
  })

  // 6. Read and control power state.
  ctx.tools.register({
    name: 'vm_power',
    description:
      'Read or change the power state of one VMware virtual machine. `state` reads the current state; other actions power it on/off, reset, suspend, pause, or resume it.',
    parameters: {
      type: 'object',
      properties: {
        vmx: { type: 'string', description: 'Absolute path to the .vmx file of the virtual machine.' },
        action: {
          type: 'string',
          enum: ['state', 'start', 'stop', 'reset', 'suspend', 'pause', 'unpause'],
          description: 'The operation to perform.',
        },
        mode: {
          type: 'string',
          description: 'For start: gui or nogui (default gui). For stop/reset/suspend: soft or hard (default soft).',
        },
      },
      required: ['vmx', 'action'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const action = args.action
      if (action === 'state') {
        const result = await vmrun(config, ['list'], { timeout: timeoutMs, signal: exec.signal })
        if (!result.ok) return { ok: false, error: vmrunFailure(result) }
        const running = result.output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .some((line) => normalizeKey(line) === normalizeKey(args.vmx))
        return { ok: true, vmx: args.vmx, running }
      }
      const modeArgs = []
      if (action === 'start') {
        modeArgs.push(args.mode === 'nogui' ? 'nogui' : 'gui')
      } else if (action === 'stop' || action === 'reset' || action === 'suspend') {
        modeArgs.push(args.mode === 'hard' ? 'hard' : 'soft')
      }
      const result = await vmrun(config, [action, args.vmx, ...modeArgs], { timeout: Math.max(timeoutMs, 300000), signal: exec.signal })
      if (!result.ok) return { ok: false, error: vmrunFailure(result) }
      return { ok: true, action, vmx: args.vmx, output: result.output || '(no output)' }
    },
  })

  // 7. Execute a command inside the guest OS.
  ctx.tools.register({
    name: 'vm_guest_exec',
    description:
      'Execute a command or script inside the guest operating system of a running virtual machine via runScriptInGuest. ' +
      'Requires VMware Tools (or open-vm-tools) running in the guest. Returns the command output. ' +
      'The interpreter defaults to cmd.exe for Windows guests and /bin/sh otherwise.',
    parameters: {
      type: 'object',
      properties: {
        vmx: { type: 'string', description: 'Absolute path to the .vmx file.' },
        command: { type: 'string', description: 'The script text to execute inside the guest.' },
        interpreter: { type: 'string', description: 'Guest path to the interpreter, e.g. /bin/bash or powershell.exe; auto-detected when omitted.' },
        guestUser: { type: 'string', description: 'Guest OS username; defaults to the credentials stored for this VM.' },
        guestPassword: { type: 'string', description: 'Guest OS password; defaults to the credential stored for this VM.' },
        noWait: { type: 'boolean', description: 'Return immediately without waiting for the program to finish.' },
        interactive: { type: 'boolean', description: 'Run interactively in the guest.' },
      },
      required: ['vmx', 'command'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const { isWindows, program } = guestShell(args.vmx)
      const shell = args.interpreter || program
      const flags = []
      if (args.noWait) flags.push('-noWait')
      if (args.interactive) flags.push('-interactive')
      const tag = `${process.pid}-${Date.now()}`
      const hostOut = join(tmpdir(), `dsh-vm-exec-${tag}.out`)
      let output = ''
      let run
      if (isWindows) {
        const guestBat = `C:\\Windows\\Temp\\_dsh_vm_exec_${tag}.bat`
        const guestOut = `C:\\Windows\\Temp\\_dsh_vm_exec_${tag}.out`
        const hostBat = join(tmpdir(), `dsh-vm-exec-${tag}.bat`)
        const bat = ['@echo off', 'chcp 65001 >nul', 'set PATH=C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;%PATH%', `( ${args.command} ) > ${guestOut} 2>&1`, ''].join('\r\n')
        writeFileSync(hostBat, bat, 'utf8')
        const copyIn = await vmrun(config, ['CopyFileFromHostToGuest', args.vmx, hostBat, guestBat], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
        try { unlinkSync(hostBat) } catch {}
        if (!copyIn.ok) return { ok: false, error: 'Failed to stage guest script: ' + vmrunFailure(copyIn) }
        run = await vmrun(config, ['runProgramInGuest', args.vmx, ...flags, shell, '/c ' + guestBat], { timeout: Math.max(timeoutMs, 300000), signal: exec.signal }, await guestFor(args))
        const copyOut = await vmrun(config, ['CopyFileFromGuestToHost', args.vmx, guestOut, hostOut], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
        if (copyOut.ok && existsSync(hostOut)) {
          try { output = readFileSync(hostOut, 'utf8') } catch { output = '' }
          try { unlinkSync(hostOut) } catch {}
        }
        await vmrun(config, ['deleteFileInGuest', args.vmx, guestBat], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
        await vmrun(config, ['deleteFileInGuest', args.vmx, guestOut], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
      } else {
        const guestSh = `/tmp/_dsh_vm_exec_${tag}.sh`
        const guestOut = `/tmp/_dsh_vm_exec_${tag}.out`
        const hostSh = join(tmpdir(), `dsh-vm-exec-${tag}.sh`)
        const sh = `#!/bin/sh\n{ ${args.command}; } > ${guestOut} 2>&1\n`
        writeFileSync(hostSh, sh, 'utf8')
        const copyIn = await vmrun(config, ['CopyFileFromHostToGuest', args.vmx, hostSh, guestSh], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
        try { unlinkSync(hostSh) } catch {}
        if (!copyIn.ok) return { ok: false, error: 'Failed to stage guest script: ' + vmrunFailure(copyIn) }
        run = await vmrun(config, ['runProgramInGuest', args.vmx, ...flags, shell, guestSh], { timeout: Math.max(timeoutMs, 300000), signal: exec.signal }, await guestFor(args))
        const copyOut = await vmrun(config, ['CopyFileFromGuestToHost', args.vmx, guestOut, hostOut], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
        if (copyOut.ok && existsSync(hostOut)) {
          try { output = readFileSync(hostOut, 'utf8') } catch { output = '' }
          try { unlinkSync(hostOut) } catch {}
        }
        await vmrun(config, ['deleteFileInGuest', args.vmx, guestSh], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
        await vmrun(config, ['deleteFileInGuest', args.vmx, guestOut], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
      }
      if (!run.ok) return { ok: false, error: vmrunFailure(run), output }
      return { ok: true, vmx: args.vmx, interpreter: shell, output: output || '(no output)' }
    },
  })

  // 8. List or kill processes inside the guest OS.
  ctx.tools.register({
    name: 'vm_guest_processes',
    description:
      'List running processes inside the guest operating system, or kill one by its process id. Requires VMware Tools running in the guest.',
    parameters: {
      type: 'object',
      properties: {
        vmx: { type: 'string', description: 'Absolute path to the .vmx file.' },
        action: { type: 'string', enum: ['list', 'kill'], description: 'list processes, or kill one process.' },
        pid: { type: 'string', description: 'Process id to kill; required for action kill.' },
        guestUser: { type: 'string', description: 'Guest OS username; defaults to the credentials stored for this VM.' },
        guestPassword: { type: 'string', description: 'Guest OS password; defaults to the credential stored for this VM.' },
      },
      required: ['vmx', 'action'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      if (args.action === 'kill') {
        if (!args.pid) return { ok: false, error: 'pid is required for action kill' }
        const result = await vmrun(config, ['killProcessInGuest', args.vmx, String(args.pid)], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
        if (!result.ok) return { ok: false, error: vmrunFailure(result) }
        return { ok: true, action: 'kill', pid: args.pid, output: result.output || '(no output)' }
      }
      const result = await vmrun(config, ['listProcessesInGuest', args.vmx], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
      if (!result.ok) return { ok: false, error: vmrunFailure(result) }
      return { ok: true, action: 'list', output: result.output || '(no processes)' }
    },
  })

  // 9. File and directory operations inside the guest OS.
  ctx.tools.register({
    name: 'vm_guest_file',
    description:
      'Operate on files and directories inside the guest operating system: list a directory, check existence, create or remove directories, delete files, copy files between host and guest, and rename. Requires VMware Tools running in the guest.',
    parameters: {
      type: 'object',
      properties: {
        vmx: { type: 'string', description: 'Absolute path to the .vmx file.' },
        action: { type: 'string', enum: ['list', 'exists', 'isDir', 'mkdir', 'rmdir', 'delete', 'copyToHost', 'copyFromHost', 'rename'], description: 'The file operation to perform.' },
        path: { type: 'string', description: 'Guest path used by list/exists/isDir/mkdir/rmdir/delete.' },
        hostPath: { type: 'string', description: 'Host path used by copyToHost and copyFromHost.' },
        newPath: { type: 'string', description: 'Destination guest path used by rename.' },
        guestUser: { type: 'string', description: 'Guest OS username; defaults to the credentials stored for this VM.' },
        guestPassword: { type: 'string', description: 'Guest OS password; defaults to the credential stored for this VM.' },
      },
      required: ['vmx', 'action'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const a = args.action
      const need = (p) => { if (!args[p]) throw new Error(`${p} is required for action ${a}`) }
      let cmdArgs
      switch (a) {
        case 'list': need('path'); cmdArgs = ['listDirectoryInGuest', args.vmx, args.path]; break
        case 'exists': need('path'); cmdArgs = ['fileExistsInGuest', args.vmx, args.path]; break
        case 'isDir': need('path'); cmdArgs = ['directoryExistsInGuest', args.vmx, args.path]; break
        case 'mkdir': need('path'); cmdArgs = ['createDirectoryInGuest', args.vmx, args.path]; break
        case 'rmdir': need('path'); cmdArgs = ['deleteDirectoryInGuest', args.vmx, args.path]; break
        case 'delete': need('path'); cmdArgs = ['deleteFileInGuest', args.vmx, args.path]; break
        case 'copyToHost': need('path'); need('hostPath'); cmdArgs = ['CopyFileFromGuestToHost', args.vmx, args.path, args.hostPath]; break
        case 'copyFromHost': need('path'); need('hostPath'); cmdArgs = ['CopyFileFromHostToGuest', args.vmx, args.hostPath, args.path]; break
        case 'rename': need('path'); need('newPath'); cmdArgs = ['renameFileInGuest', args.vmx, args.path, args.newPath]; break
        default: return { ok: false, error: `unknown action: ${a}` }
      }
      const result = await vmrun(config, cmdArgs, { timeout: Math.max(timeoutMs, 300000), signal: exec.signal }, await guestFor(args))
      if (!result.ok) return { ok: false, error: vmrunFailure(result) }
      return { ok: true, action: a, output: result.output || '(done)' }
    },
  })

  // 10. Capture a screenshot of the guest.
  ctx.tools.register({
    name: 'vm_guest_screenshot',
    description:
      'Capture the screen of the guest operating system to a PNG file on the host. Requires VMware Tools running in the guest.',
    parameters: {
      type: 'object',
      properties: {
        vmx: { type: 'string', description: 'Absolute path to the .vmx file.' },
        hostPath: { type: 'string', description: 'Host path (including .png filename) to save the screenshot to.' },
        guestUser: { type: 'string', description: 'Guest OS username; defaults to the credentials stored for this VM.' },
        guestPassword: { type: 'string', description: 'Guest OS password; defaults to the credential stored for this VM.' },
      },
      required: ['vmx', 'hostPath'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const result = await vmrun(config, ['captureScreen', args.vmx, args.hostPath], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
      if (!result.ok) return { ok: false, error: vmrunFailure(result) }
      return { ok: true, vmx: args.vmx, hostPath: args.hostPath }
    },
  })

  // 11. Guest IP address and VMware Tools state.
  ctx.tools.register({
    name: 'vm_guest_status',
    description:
      'Read the guest IP address and VMware Tools state of a running virtual machine. Requires VMware Tools running in the guest.',
    parameters: {
      type: 'object',
      properties: {
        vmx: { type: 'string', description: 'Absolute path to the .vmx file.' },
        wait: { type: 'boolean', description: 'Wait for the IP address if it is not yet available.' },
        guestUser: { type: 'string', description: 'Guest OS username; defaults to the credentials stored for this VM.' },
        guestPassword: { type: 'string', description: 'Guest OS password; defaults to the credential stored for this VM.' },
      },
      required: ['vmx'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const ipArgs = ['getGuestIPAddress', args.vmx, ...(args.wait ? ['-wait'] : [])]
      const ipResult = await vmrun(config, ipArgs, { timeout: Math.max(timeoutMs, 300000), signal: exec.signal }, await guestFor(args))
      const toolsResult = await vmrun(config, ['checkToolsState', args.vmx], { timeout: timeoutMs, signal: exec.signal }, await guestFor(args))
      return {
        ok: true,
        vmx: args.vmx,
        ip: ipResult.ok ? (ipResult.output || null) : null,
        ipError: ipResult.ok ? null : vmrunFailure(ipResult),
        toolsState: toolsResult.ok ? (toolsResult.output || 'unknown') : null,
      }
    },
  })

  // 12. Manage the stored guest credentials of each virtual machine.
  ctx.tools.register({
    name: 'vm_credentials',
    description:
      'List, save, or forget the guest OS credentials stored for local virtual machines. ' +
      'Credentials are kept in the DSH credential store, one record per virtual machine, and are used ' +
      'automatically by the vm_guest_* tools when no guestUser/guestPassword is passed to them. ' +
      'Passwords are never read back: a stored entry reports only the user name and a fixed mask.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'set', 'forget'], description: 'list stored entries, save one entry, or forget one entry.' },
        vmx: { type: 'string', description: 'Absolute path to the .vmx file; required for actions set and forget.' },
        guestUser: { type: 'string', description: 'Guest OS username; required for action set.' },
        guestPassword: { type: 'string', description: 'Guest OS password; required for action set. Never returned afterwards.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args) {
      if (!credentials) {
        return { ok: false, error: 'The DSH credential store is not available in this deployment.', configured: false, entries: [] }
      }
      if (args.action === 'set') {
        if (!args.vmx) return { ok: false, error: 'vmx is required for action set' }
        if (!args.guestUser || !args.guestPassword) return { ok: false, error: 'guestUser and guestPassword are required for action set' }
        const written = await rememberGuest(credentials, args.vmx, args.guestUser, args.guestPassword)
        return { ok: true, action: 'set', vmx: args.vmx, guestUser: args.guestUser, stored: true, changed: written }
      }
      if (args.action === 'forget') {
        if (!args.vmx) return { ok: false, error: 'vmx is required for action forget' }
        const forgotten = await forgetGuest(credentials, args.vmx)
        return { ok: forgotten, action: 'forget', vmx: args.vmx, forgotten }
      }
      const entries = await listGuests(credentials)
      return { ok: true, action: 'list', count: entries.length, entries }
    },
  })

  // Human command for the same store: /vm-credentials [list|forget <vmx>]
  const commands = ctx.get('commands')
  if (commands && typeof commands.register === 'function') {
    ctx.effect(() =>
      commands.register({
        name: 'vm-credentials',
        description: 'List or forget the stored guest credentials of local virtual machines.',
        input: { hint: 'list | forget <vmx path>' },
        handler: async (invocation) => {
          const [verb, ...rest] = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
          const action = (verb ?? 'list').toLowerCase()
          if (action === 'forget') {
            const vmx = rest.join(' ').replace(/^"|"$/g, '')
            if (!vmx) return { kind: 'error', text: 'Usage: /vm-credentials forget <vmx path>' }
            const forgotten = await forgetGuest(credentials, vmx)
            return forgotten
              ? { kind: 'success', text: `Forgot stored guest credentials for ${vmx}` }
              : { kind: 'error', text: `No stored guest credentials could be removed for ${vmx}` }
          }
          if (action !== 'list') return { kind: 'error', text: 'Usage: /vm-credentials list | forget <vmx path>' }
          const entries = await listGuests(credentials)
          if (entries.length === 0) return { kind: 'success', text: 'No stored guest credentials.' }
          const lines = entries.map((entry) => `- ${entry.name ?? entry.vmx}  user=${entry.guestUser ?? '?'}  password=${PASSWORD_MASK}  updated=${entry.updatedAt ?? '?'}  key=${entry.key}`)
          return { kind: 'success', text: [`Stored guest credentials (${entries.length}):`, ...lines].join('\n') }
        },
      }),
      'vmware-tools: vm-credentials command',
    )
  }

  // Settings page backend: one exact route, owned by the browser peer.
  const connection = ctx.get('connection')
  if (connection && connection.fetch && typeof connection.fetch.register === 'function') {
    ctx.effect(
      () =>
        connection.fetch.register({
          path: CREDENTIALS_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body = null
            try {
              body = await request.json()
            } catch {
              return jsonResponse(400, { ok: false, error: 'Request body must be JSON.' })
            }
            const op = body && typeof body.op === 'string' ? body.op : ''
            if (op === 'vms') return jsonResponse(200, { ok: true, vms: readInventory() ?? [] })
            if (!credentials) return jsonResponse(200, { ok: false, error: 'The DSH credential store is not available in this deployment.', entries: [] })
            if (op === 'list') return jsonResponse(200, { ok: true, entries: await listGuests(credentials) })
            if (op === 'set') {
              const vmx = typeof body.vmx === 'string' ? body.vmx : ''
              const guestUser = typeof body.guestUser === 'string' ? body.guestUser : ''
              const guestPassword = typeof body.guestPassword === 'string' ? body.guestPassword : ''
              if (!vmx || !guestUser || !guestPassword) return jsonResponse(400, { ok: false, error: 'vmx, guestUser and guestPassword are required.' })
              await rememberGuest(credentials, vmx, guestUser, guestPassword)
              return jsonResponse(200, { ok: true, entries: await listGuests(credentials) })
            }
            if (op === 'forget') {
              const vmx = typeof body.vmx === 'string' ? body.vmx : ''
              if (!vmx) return jsonResponse(400, { ok: false, error: 'vmx is required.' })
              await forgetGuest(credentials, vmx)
              return jsonResponse(200, { ok: true, entries: await listGuests(credentials) })
            }
            return jsonResponse(400, { ok: false, error: `Unknown op: ${op || '(empty)'}` })
          },
        }),
      'vmware-tools: guest credential route',
    )
  }
}

/** Build a JSON response for the settings-page credential route. */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

function normalizeKey(path) {
  return (path ?? '').replace(/\\/g, '/').toLowerCase()
}

// ---------------------------------------------------------------------------
// Guest credential store (DSH credentials service records)
// ---------------------------------------------------------------------------
//
// Each VM's guest credentials live in one `grant` record owned by this plugin:
//   key     dsh-vmware-tools/<vm-slug>-<path-hash>
//   payload { vmx, name, guestUser, guestPassword, updatedAt }
// Passwords are never returned to a model, a command, or the settings page —
// only `configured`, the user name, and a fixed mask.

/** Scope segment of every record this plugin owns; also its registered name. */
const CREDENTIAL_SCOPE = 'dsh-vmware-tools'

/** Path of the browser-facing endpoint that backs the settings page. */
const CREDENTIALS_ROUTE = '/api/vmware.credentials'

/** Masked stand-in for a stored password; the value itself never leaves the host. */
const PASSWORD_MASK = '********'

/** Resolve the credentials service, or null when this deployment has none. */
function credentialsOf(ctx) {
  const service = ctx.get('credentials')
  if (!service || typeof service.readRecord !== 'function' || typeof service.modifyRecord !== 'function') return null
  return service
}

/** Lowercase hyphenated slug that satisfies the credential-key id segment. */
function slugOf(text) {
  const slug = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return /^[a-z]/.test(slug) ? slug : `vm-${slug || 'guest'}`
}

/** 32-bit FNV-1a hash as eight lowercase hex digits, for a stable path-based suffix. */
function shortHash(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Build the credential key for one VMX path. */
function credentialKeyFor(vmx) {
  const name = basename(vmx ?? '', '.vmx')
  return `${CREDENTIAL_SCOPE}/${slugOf(name)}-${shortHash(normalizeKey(vmx))}`
}

/** Read one VM's stored credential payload, or null. */
async function readGuestRecord(credentials, vmx) {
  if (!credentials) return null
  try {
    const record = await credentials.readRecord(credentialKeyFor(vmx))
    if (!record || record.kind !== 'grant') return null
    const payload = record.payload
    if (!payload || typeof payload !== 'object') return null
    return payload
  } catch {
    return null
  }
}

/** Persist one VM's guest credentials; an unchanged payload is left untouched. */
async function rememberGuest(credentials, vmx, guestUser, guestPassword) {
  if (!credentials || !vmx || !guestUser || !guestPassword) return false
  const key = credentialKeyFor(vmx)
  let written = false
  try {
    await credentials.modifyRecord(key, async (current) => {
      const payload = current && current.kind === 'grant' ? current.payload : null
      const same = payload && payload.vmx === vmx && payload.guestUser === guestUser && payload.guestPassword === guestPassword
      if (same) return undefined
      written = true
      return {
        kind: 'grant',
        payload: {
          vmx,
          name: basename(vmx, '.vmx'),
          guestUser,
          guestPassword,
          updatedAt: new Date().toISOString(),
        },
      }
    })
  } catch {
    return false
  }
  return written
}

/** Remove one VM's stored credentials. */
async function forgetGuest(credentials, vmx) {
  if (!credentials || !vmx) return false
  try {
    await credentials.deleteRecord(credentialKeyFor(vmx))
    return true
  } catch {
    return false
  }
}

/** Every stored guest record owned by this plugin, passwords masked out. */
async function listGuests(credentials) {
  if (!credentials) return []
  let entries = []
  try {
    entries = await credentials.listRecords()
  } catch {
    return []
  }
  const owned = entries.filter((entry) => String(entry.key).startsWith(`${CREDENTIAL_SCOPE}/`))
  const result = []
  for (const entry of owned) {
    let payload = null
    try {
      const record = await credentials.readRecord(entry.key)
      payload = record && record.kind === 'grant' ? record.payload : null
    } catch {
      payload = null
    }
    if (!payload || typeof payload !== 'object') continue
    result.push({
      key: String(entry.key),
      vmx: typeof payload.vmx === 'string' ? payload.vmx : null,
      name: typeof payload.name === 'string' ? payload.name : null,
      guestUser: typeof payload.guestUser === 'string' ? payload.guestUser : null,
      guestPassword: PASSWORD_MASK,
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    })
  }
  return result
}

/**
 * Resolve the guest credentials for one call: explicit arguments first, then the
 * stored record for that VM, then the plugin configuration. Explicit user+password
 * pairs are remembered on the way through, so one successful call is enough.
 */
async function resolveGuest(credentials, config, args) {
  const explicitUser = typeof args.guestUser === 'string' && args.guestUser.length > 0 ? args.guestUser : null
  const explicitPassword = typeof args.guestPassword === 'string' && args.guestPassword.length > 0 ? args.guestPassword : null
  if (explicitUser && explicitPassword) {
    await rememberGuest(credentials, args.vmx, explicitUser, explicitPassword)
    return { guestUser: explicitUser, guestPassword: explicitPassword }
  }
  if (explicitUser || explicitPassword) {
    const stored = await readGuestRecord(credentials, args.vmx)
    const user = explicitUser ?? (typeof stored?.guestUser === 'string' ? stored.guestUser : config.guestUser)
    const password = explicitPassword ?? (typeof stored?.guestPassword === 'string' ? stored.guestPassword : config.guestPassword)
    return { guestUser: user, guestPassword: password }
  }
  const stored = await readGuestRecord(credentials, args.vmx)
  if (stored && typeof stored.guestUser === 'string' && typeof stored.guestPassword === 'string') {
    return { guestUser: stored.guestUser, guestPassword: stored.guestPassword }
  }
  return { guestUser: config.guestUser, guestPassword: config.guestPassword }
}

/** Detect the guest shell from the VM's guestOS. */
function guestShell(vmxPath) {
  const read = readVmxSettings(vmxPath)
  const guestOS = read.ok ? (read.settings.guestOS || '').toLowerCase() : ''
  const isWindows = guestOS.includes('win')
  return { isWindows, program: isWindows ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh' }
}
