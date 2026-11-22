# VMware control

This plugin registers model-facing tools that read and control local VMware
virtual machines (VMware Workstation or Player) through the `vmrun`
command-line tool, and remembers each machine's guest credentials.

## Tools

| Tool | Purpose |
| --- | --- |
| `vm_list` | List registered and running virtual machines with names, paths, and running state. |
| `vm_get_config` | Read VMX configuration variables (one key, several keys, or the full `.vmx` file). |
| `vm_set_config` | Write VMX configuration variables. |
| `vm_create` | Clone an existing VM or create a blank VM (optionally with a new disk). |
| `vm_delete` | Delete a VM from the inventory and remove its files. |
| `vm_power` | Read state, or power on/off, reset, suspend, pause, and resume a VM. |
| `vm_guest_exec` | Execute a command or script inside the guest operating system. |
| `vm_guest_processes` | List or kill processes inside the guest operating system. |
| `vm_guest_file` | List, check, create, delete, rename, and copy files/directories in the guest. |
| `vm_guest_screenshot` | Capture the guest screen to a PNG file on the host. |
| `vm_guest_status` | Read the guest IP address and VMware Tools state. |
| `vm_credentials` | List, save, or forget the stored guest credentials of each VM. |

## Guest credentials

Guest credentials are stored per virtual machine in the DSH credential store,
as `grant` records owned by this plugin:

- key — `dsh-vmware-tools/<vm-slug>-<path-hash>`
- payload — `{ vmx, name, guestUser, guestPassword, updatedAt }`

Resolution order for every `vm_guest_*` call is: explicit `guestUser` /
`guestPassword` arguments, then the record stored for that VM, then the
`guestUser` / `guestPassword` plugin configuration.

A call that passes an explicit user name **and** password stores them for that
VM automatically, so one successful call is enough. Passwords are write-only:
`vm_credentials` and the settings page report only the user name and a fixed
mask, never the password.

## Command

`/vm-credentials` lists the stored entries (`/vm-credentials list`), or forgets
one of them (`/vm-credentials forget <vmx path>`). The command never accepts a
password — saving one belongs to the tools or the settings page.

## Settings page

**Settings → VMware guest credentials** (`settings.section`, id
`vmware-credentials`) lists the stored entries and lets you pick a virtual
machine from the VMware inventory, enter a user name and password, replace an
existing entry, or forget one. The page talks to the Host half over an exact
route at `api/vmware.credentials` (`{ op: list | set | forget }`), so passwords
travel from the browser to the Host only once, on save.

## Requirements

- VMware Workstation or VMware Player must be installed, and `vmrun.exe` must be
  reachable. The plugin auto-detects the standard install path; set `vmrunPath`
  in the plugin configuration if it is installed elsewhere, or set the
  `VMWARE_VMRUN` environment variable.
- `vmrun` must be able to start. If it reports "vmrun was unable to start",
  start VMware Workstation or repair its VIX installation.
- In-guest tools (`vm_guest_*`) require VMware Tools (or open-vm-tools) running
  in the guest, and guest credentials. Save them once per VM (tool, command, or
  settings page), or set `guestUser`/`guestPassword` in the plugin configuration.

## Configuration

- `vmrunPath` — absolute path to `vmrun.exe` (auto-detected when empty).
- `vmrunType` — `ws` (Workstation), `player`, or `fusion`. Defaults to `ws`.
- `vmDir` — default directory for newly created VMs.
- `timeoutMs` — per-command timeout in milliseconds (default 120000).
- `guestUser` — fallback guest OS username when no per-VM record exists.
- `guestPassword` — fallback guest OS password when no per-VM record exists.

## Safety

Power control and deletion are destructive. `vm_delete` removes a virtual
machine and its files and cannot be undone; verify the `.vmx` path before
deleting. Review each destructive request in the conversation.
