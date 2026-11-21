# VMware control

This plugin registers model-facing tools that read and control local VMware
virtual machines (VMware Workstation or Player) through the `vmrun`
command-line tool.

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

## Requirements

- VMware Workstation or VMware Player must be installed, and `vmrun.exe` must be
  reachable. The plugin auto-detects the standard install path; set `vmrunPath`
  in the plugin configuration if it is installed elsewhere, or set the
  `VMWARE_VMRUN` environment variable.
- `vmrun` must be able to start. If it reports "vmrun was unable to start",
  start VMware Workstation or repair its VIX installation.
- In-guest tools (`vm_guest_*`) require VMware Tools (or open-vm-tools) running
  in the guest, and usually guest credentials. Pass `guestUser`/`guestPassword`
  per call, or set `guestUser`/`guestPassword` in the plugin configuration.

## Configuration

- `vmrunPath` — absolute path to `vmrun.exe` (auto-detected when empty).
- `vmrunType` — `ws` (Workstation), `player`, or `fusion`. Defaults to `ws`.
- `vmDir` — default directory for newly created VMs.
- `timeoutMs` — per-command timeout in milliseconds (default 120000).
- `guestUser` — default guest OS username for in-guest operations.
- `guestPassword` — default guest OS password for in-guest operations.

## Safety

Power control and deletion are destructive. `vm_delete` removes a virtual
machine and its files and cannot be undone; verify the `.vmx` path before
deleting. Review each destructive request in the conversation.
