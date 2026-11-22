# dsh-vmware-tools

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that lets the model
read and control **local VMware virtual machines** — and the operating systems
running inside them.

Every capability is exposed as a model-facing tool built on VMware's `vmrun`
command-line interface, so the model can list your VMs, read and change their
settings, create and delete them, power them on and off, and run commands,
move files, and take screenshots inside the guest.

```
┌──────────────────────────┐        vmrun        ┌──────────────────────────┐
│  DeepSeek Harness model  │ ──────────────────► │  VMware Workstation /    │
│  (12 dsh-vmware tools)   │ ◄────────────────── │  Player VMs on this host │
└──────────────────────────┘                     └──────────────────────────┘
```

## Features

| Area | What the model can do |
| --- | --- |
| **List VMs** | Enumerate registered and running virtual machines with names, `.vmx` paths, and running state. |
| **Read / write settings** | Read one VMX variable, several, or the whole `.vmx` file; write VMX variables back. |
| **Add / remove VMs** | Clone an existing VM (full or linked), create a blank VM with a fresh virtual disk, or delete a VM with its files. |
| **Read / write state** | Query power state and start, stop, reset, suspend, pause, and resume a VM. |
| **Operate the guest** | Run commands and scripts, list and kill processes, manage and copy files, capture the screen, and read the guest IP address. |
| **Remember credentials** | Store each VM's guest user name and password once — automatically on the first call that passes them, or from the settings page — and reuse it for every later in-guest call. |

## Tools

### Virtual machine level

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `vm_list` | — | List registered VMs with paths, display names, and running state. |
| `vm_get_config` | `vmx`, `keys?` | Read VMX variables (single key, list of keys, or the entire `.vmx`). |
| `vm_set_config` | `vmx`, `settings` | Write VMX variables; the VM must be powered off to persist. |
| `vm_create` | `name`, `cloneFrom?`, `cloneType?`, `dir?`, `diskSizeGB?`, `guestOS?`, `memSizeMB?`, `numVcpus?` | Clone an existing VM or create a blank one, optionally with a new disk. |
| `vm_delete` | `vmx` | Delete a VM from the inventory and remove its files. **Destructive.** |
| `vm_power` | `vmx`, `action`, `mode?` | `state` \| `start` \| `stop` \| `reset` \| `suspend` \| `pause` \| `unpause`. |

### Guest OS level (`vm_guest_*`)

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `vm_guest_exec` | `vmx`, `command`, `interpreter?`, `guestUser?`, `guestPassword?`, `noWait?`, `interactive?` | Execute a command or script inside the guest and return its output. |
| `vm_guest_processes` | `vmx`, `action`, `pid?`, … | `list` processes, or `kill` one by pid. |
| `vm_guest_file` | `vmx`, `action`, `path?`, `hostPath?`, `newPath?`, … | `list` \| `exists` \| `isDir` \| `mkdir` \| `rmdir` \| `delete` \| `copyToHost` \| `copyFromHost` \| `rename`. |
| `vm_guest_screenshot` | `vmx`, `hostPath`, … | Capture the guest screen to a PNG on the host. |
| `vm_guest_status` | `vmx`, `wait?`, … | Read the guest IP address and VMware Tools state. |

### Credentials

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `vm_credentials` | `action`, `vmx?`, `guestUser?`, `guestPassword?` | `list` the stored per-VM entries, `set` one, or `forget` one. Passwords are never returned — an entry reports the user name and a mask only. |

## Guest credentials

Each virtual machine can have its guest credentials remembered in the DSH
credential store, as one `grant` record owned by this plugin:

- key — `dsh-vmware-tools/<vm-slug>-<path-hash>`
- payload — `{ vmx, name, guestUser, guestPassword, updatedAt }`

Every `vm_guest_*` call resolves credentials in this order:

1. the `guestUser` / `guestPassword` arguments of that call,
2. the record stored for that VM,
3. the `guestUser` / `guestPassword` plugin configuration.

A call that passes an explicit user name **and** password also stores them for
that VM, so a single successful call is enough — later calls can omit both
arguments. Passwords are write-only: nothing in the plugin, the tool output, the
command, or the settings page reads one back.

Manage the store in three ways:

```jsonc
// list
{ "action": "list" }

// save (also happens automatically on any guest call with both values)
{ "action": "set", "vmx": "C:\\...\\Windows 10 x64.vmx", "guestUser": "Administrator", "guestPassword": "…" }

// forget
{ "action": "forget", "vmx": "C:\\...\\Windows 10 x64.vmx" }
```

### Command

`/vm-credentials` lists the stored entries; `/vm-credentials forget <vmx path>`
removes one. The command deliberately accepts no password — saving one belongs
to the tool or the settings page.

### Settings page

**Settings → VMware guest credentials** lists the stored entries and lets you
pick a virtual machine from the VMware inventory, type a user name and password,
replace an entry, or forget it. The page is a Client half of this bundle
(`client.js`) that talks to the Host half over the exact route
`api/vmware.credentials` with `{ op: "list" | "set" | "forget" }`.

## Requirements

| Requirement | Notes |
| --- | --- |
| VMware Workstation or VMware Player (Windows) | VMware Fusion is detected on macOS. |
| `vmrun.exe` | Auto-detected in the standard install locations. Override with the `vmrunPath` config key or the `VMWARE_VMRUN` environment variable. |
| VMware Tools / open-vm-tools | Required only for the `vm_guest_*` tools. |
| Guest credentials | In-guest operations need a **non-empty** guest password; VIX refuses anonymous guest logins. Pass `guestUser` / `guestPassword` per call or set them in the config. |

## Installation

1. Clone or download this repository so the folder is on the machine running
   DeepSeek Harness.

   ```bash
   git clone https://github.com/HaskHaskHask/dsh-vmware-tools.git
   ```

2. Install the folder as a DSH plugin bundle. The repository contains
   `package.json` with a `dsh.bundle.patch` entry pointing at
   `cordis.patch.yml`, so DSH can load it directly. Point the plugin manager at
   the absolute path of the checkout directory.

3. After changing `index.js`, disable and re-enable the plugin in the plugin
   manager to reload it.

## Configuration

Configuration lives in the `config` block of `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-vmware-tools
      name: 'dsh-vmware-tools'
      config:
        vmrunPath: 'C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe'
        vmrunType: ws
        timeoutMs: 120000
        # guestUser: Administrator
        # guestPassword: your-guest-password
```

| Key | Default | Meaning |
| --- | --- | --- |
| `vmrunPath` | auto-detected | Absolute path to `vmrun.exe`. |
| `vmrunType` | `ws` | `vmrun -T` type: `ws` (Workstation), `player`, or `fusion`. |
| `vmDir` | `~/Documents/Virtual Machines` | Default parent directory for newly created VMs. |
| `timeoutMs` | `120000` | Per-command timeout in milliseconds. |
| `guestUser` | — | Fallback guest OS username, used only when the VM has no stored record. |
| `guestPassword` | — | Fallback guest OS password, used only when the VM has no stored record. |

## Usage examples

The model calls these tools on its own; the examples below show what each call
looks like.

List every virtual machine:

```jsonc
{ "tool": "vm_list" }   // no arguments
```

Read and change a setting:

```jsonc
{ "tool": "vm_get_config", "arguments": { "vmx": "C:\\Users\\me\\Documents\\Virtual Machines\\Lab\\Lab.vmx", "keys": ["memsize", "numvcpus"] } }
{ "tool": "vm_set_config", "arguments": { "vmx": "C:\\...\\Lab.vmx", "settings": { "memsize": "8192", "numvcpus": "4" } } }
```

Create a clone and power it on:

```jsonc
{ "tool": "vm_create", "arguments": { "name": "Lab-copy", "cloneFrom": "C:\\...\\Lab.vmx", "cloneType": "full" } }
{ "tool": "vm_power",  "arguments": { "vmx": "C:\\Users\\me\\Documents\\Virtual Machines\\Lab-copy\\Lab-copy.vmx", "action": "start", "mode": "nogui" } }
```

Operate inside the guest:

```jsonc
{ "tool": "vm_guest_exec",       "arguments": { "vmx": "C:\\...\\Lab-copy.vmx", "command": "ipconfig /all", "guestUser": "Administrator", "guestPassword": "***" } }
{ "tool": "vm_guest_screenshot", "arguments": { "vmx": "C:\\...\\Lab-copy.vmx", "hostPath": "C:\\temp\\guest.png", "guestUser": "Administrator", "guestPassword": "***" } }
```

## How in-guest execution works

VMware Workstation's `runProgramInGuest` does not forward the guest command's
stdout back to `vmrun`, and VIX launches guest programs with a stripped `PATH`.
`vm_guest_exec` therefore:

1. writes a small `.bat` (Windows) or `.sh` (Linux) script on the host,
2. copies it into the guest,
3. runs it through `runProgramInGuest`, redirecting output to a guest file and
   restoring a usable `PATH`,
4. copies the output file back to the host and returns its contents,
5. deletes both temporary files from the guest.

The interpreter is chosen from the VM's `guestOS` value — `cmd.exe` for Windows
guests, `/bin/sh` otherwise — and can be overridden with `interpreter`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `vmrun was unable to start. Please make sure that vmrun is installed correctly…` | The VIX wrapper cannot find its implementation directory. Check `vixwrapper-product-config.txt` in the Workstation folder: the `Workstation-<version>` directory it names must exist (it may only be present under `VMware\VMware VIX`). Creating a directory junction usually repairs this. |
| `vmrun` works only while a VM is already running | Cold start from the command line may fail on some installs; start the VM once from the Workstation GUI. |
| `Command requires valid user name and password for the guest OS` | VIX refuses empty passwords — use a guest account with a password. |
| `This operation is not supported` / `Unrecognized command` | `listRegisteredVM` and `getGuestState` are missing from some `vmrun` builds; this plugin uses `vmrun list` and the VMware inventory instead. |
| Guest command output is empty | Expected for raw `runProgramInGuest`; `vm_guest_exec` works around it by copying an output file back. |
| `Unable to get the IP address` right after resume | The guest network is not up yet; retry with `vm_guest_status` passing `wait: true`. |
| Suspending a paused VM fails with `The virtual machine is paused` | Unpause it first (`vm_power` with `action: "unpause"`), then suspend. |
| A guest call fails with a credentials error although one was stored | The stored record is keyed by the `.vmx` path — check it matches the path you pass. `/vm-credentials` lists the stored paths. |

## Safety notes

- `vm_delete` and every power action are destructive. `vm_delete` removes the VM
  **and its files** and cannot be undone — verify the `.vmx` path first.
- `vm_guest_exec` runs arbitrary commands inside the guest, typically as an
  administrator. Prefer disposable or snapshot-protected VMs.
- Store guest credentials per VM — the first call that passes a user name and
  password stores them, and the settings page can do it explicitly. They are
  written to the DSH credential store, never returned, and handed to `vmrun` as
  `-gu` / `-gp`.

## Repository layout

```
.
├── index.js            # Host half: registers the 12 model tools, the command,
│                       #   the credential records, and the settings route
├── client.js           # Client half: the Settings → VMware guest credentials page
├── cordis.patch.yml    # DSH bundle patch that enables the plugin
├── package.json        # bundle manifest (dsh.bundle.patch, dsh.client)
├── icon.svg            # plugin icon
├── locale/             # en.json, zh.json metadata
└── docs/DETAIL.md      # tool and configuration reference
```

## License

No license has been declared for this project yet.
