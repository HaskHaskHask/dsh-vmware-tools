/**
 * Browser half of the VMware control bundle.
 *
 * Owns one Settings page that manages the guest credentials this plugin stores
 * for each virtual machine. The page talks to the Host half over a plain fetch
 * to the exact route the Host registered (`/api/vmware.credentials`), because a
 * statically loaded Client half cannot reach the Host through `host.call`.
 *
 * Passwords are write-only: the Host returns entries with a fixed mask, so the
 * page can show what is configured but can never reveal a stored password.
 */

window.__ModuleLoader__.load({
  id: 'dsh-vmware-tools',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this bundle. */
    const NS = 'dsh-vmware-tools'

    /** Document-relative form of the Host route (`/api/vmware.credentials`). */
    const ROUTE = 'api/vmware.credentials'

    /** Class prefix that keeps this page's styles away from the host styles. */
    const P = 'dvm-'

    const DICTIONARIES = {
      en: {
        title: 'VMware guest credentials',
        intro:
          'Guest credentials are stored per virtual machine in the DSH credential store. The vm_guest_* tools use them automatically, so a call no longer needs guestUser or guestPassword. Passwords are never shown again.',
        pickVm: 'Virtual machine',
        manualPath: 'Or an absolute .vmx path',
        selectPlaceholder: 'Select a virtual machine…',
        user: 'Guest user name',
        password: 'Guest password',
        save: 'Save credentials',
        refresh: 'Refresh',
        columnName: 'Virtual machine',
        columnPath: 'VMX path',
        columnUser: 'User',
        columnPassword: 'Password',
        columnUpdated: 'Updated',
        columnActions: 'Actions',
        forget: 'Forget',
        update: 'Replace',
        empty: 'No guest credentials stored yet.',
        loading: 'Loading…',
        saved: 'Credentials saved.',
        forgotten: 'Credentials removed.',
        needAll: 'Choose a virtual machine and fill in both the user name and the password.',
        noStore: 'The DSH credential store is not available in this deployment.',
      },
      zh: {
        title: 'VMware 客户机凭据',
        intro:
          '客户机凭据按虚拟机分别保存在 DSH 凭据存储中。vm_guest_* 工具会自动使用它们，调用时不再需要传 guestUser 或 guestPassword。密码保存后不会再显示。',
        pickVm: '虚拟机',
        manualPath: '或 .vmx 绝对路径',
        selectPlaceholder: '选择一台虚拟机…',
        user: '客户机用户名',
        password: '客户机密码',
        save: '保存凭据',
        refresh: '刷新',
        columnName: '虚拟机',
        columnPath: 'VMX 路径',
        columnUser: '用户名',
        columnPassword: '密码',
        columnUpdated: '更新时间',
        columnActions: '操作',
        forget: '删除',
        update: '替换',
        empty: '还没有保存任何客户机凭据。',
        loading: '加载中…',
        saved: '凭据已保存。',
        forgotten: '凭据已删除。',
        needAll: '请选择虚拟机，并同时填写用户名和密码。',
        noStore: '当前部署没有可用的 DSH 凭据存储。',
      },
    }

    const CSS = `
.${P}section { display: flex; flex-direction: column; gap: 16px; color: var(--dsw-alias-label-primary); }
.${P}h2 { margin: 0; font-size: 15px; font-weight: 600; }
.${P}intro { margin: 4px 0 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.${P}form { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 16px; align-items: end; }
.${P}field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.${P}label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.${P}input, .${P}select {
  width: 100%; box-sizing: border-box; padding: 6px 8px; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
}
.${P}input:focus, .${P}select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.${P}buttons { display: flex; gap: 8px; grid-column: 1 / -1; }
.${P}button {
  padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
}
.${P}button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.${P}button:disabled { opacity: 0.55; cursor: default; }
.${P}button.${P}primary { color: #fff; background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.${P}status { font-size: 13px; line-height: 1.5; }
.${P}status.${P}error { color: var(--dsw-alias-state-error-primary); }
.${P}status.${P}ok { color: var(--dsw-alias-state-success-primary); }
.${P}table { width: 100%; border-collapse: collapse; font-size: 13px; }
.${P}table th {
  padding: 6px 8px; font-size: 12px; font-weight: 500; text-align: left;
  color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.${P}table td { padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; }
.${P}mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.${P}empty { padding: 12px 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.${P}rowActions { display: flex; gap: 6px; white-space: nowrap; }
`

    /** POST one operation to the Host half and return its JSON payload. */
    async function callHost(op, payload) {
      const url = new URL(ROUTE, document.baseURI)
      const response = await fetch(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ op }, payload || {})),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!data) throw new Error(`The VMware credential route returned an empty response (HTTP ${response.status}).`)
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
      return data
    }

    /** Build the Settings page component with the React surface handed in. */
    function makeSection(ctx) {
      const t = ctx.locale.bind(NS)

      return function VmwareCredentialsSection() {
        const { useState, useEffect, useCallback } = React
        const [entries, setEntries] = useState([])
        const [vms, setVms] = useState([])
        const [selected, setSelected] = useState('')
        const [manualPath, setManualPath] = useState('')
        const [guestUser, setGuestUser] = useState('')
        const [guestPassword, setGuestPassword] = useState('')
        const [status, setStatus] = useState(null)
        const [busy, setBusy] = useState(false)

        const applyEntries = useCallback((data) => {
          setEntries(Array.isArray(data && data.entries) ? data.entries : [])
          if (data && data.error) setStatus({ kind: 'error', text: String(data.error) })
        }, [])

        const refresh = useCallback(async () => {
          setBusy(true)
          try {
            const data = await callHost('list')
            applyEntries(data)
          } catch (error) {
            setStatus({ kind: 'error', text: String((error && error.message) || error) })
          } finally {
            setBusy(false)
          }
        }, [applyEntries])

        useEffect(() => {
          let live = true
          ;(async () => {
            try {
              const data = await callHost('vms')
              if (!live) return
              setVms(Array.isArray(data && data.vms) ? data.vms : [])
            } catch {
              /* the inventory is a convenience only */
            }
          })()
          void refresh()
          return () => {
            live = false
          }
        }, [refresh])

        const effectiveVmx = manualPath.trim() || selected

        const submit = useCallback(
          async (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            const vmx = manualPath.trim() || selected
            if (!vmx || !guestUser.trim() || !guestPassword) {
              setStatus({ kind: 'error', text: t('needAll') })
              return
            }
            setBusy(true)
            try {
              const data = await callHost('set', { vmx, guestUser: guestUser.trim(), guestPassword })
              applyEntries(data)
              setGuestPassword('')
              setStatus({ kind: 'ok', text: t('saved') })
            } catch (error) {
              setStatus({ kind: 'error', text: String((error && error.message) || error) })
            } finally {
              setBusy(false)
            }
          },
          [applyEntries, guestPassword, guestUser, manualPath, selected, t],
        )

        const forget = useCallback(
          async (vmx) => {
            setBusy(true)
            try {
              const data = await callHost('forget', { vmx })
              applyEntries(data)
              setStatus({ kind: 'ok', text: t('forgotten') })
            } catch (error) {
              setStatus({ kind: 'error', text: String((error && error.message) || error) })
            } finally {
              setBusy(false)
            }
          },
          [applyEntries, t],
        )

        const replace = useCallback((entry) => {
          setManualPath(entry.vmx || '')
          setSelected('')
          setGuestUser(entry.guestUser || '')
          setGuestPassword('')
          setStatus(null)
        }, [])

        const options = [h('option', { key: '', value: '' }, t('selectPlaceholder'))].concat(
          vms.map((vm) => h('option', { key: vm.path, value: vm.path }, `${vm.name} — ${vm.path}`)),
        )

        const rows = entries.map((entry) =>
          h(
            'tr',
            { key: entry.key },
            h('td', null, entry.name || '—'),
            h('td', null, h('span', { className: P + 'mono' }, entry.vmx || '—')),
            h('td', null, entry.guestUser || '—'),
            h('td', null, h('span', { className: P + 'mono' }, entry.guestPassword || '—')),
            h('td', null, entry.updatedAt ? entry.updatedAt.replace('T', ' ').slice(0, 19) : '—'),
            h(
              'td',
              null,
              h(
                'div',
                { className: P + 'rowActions' },
                h('button', { type: 'button', onClick: () => replace(entry), disabled: busy }, t('update')),
                h('button', { type: 'button', onClick: () => void forget(entry.vmx), disabled: busy }, t('forget')),
              ),
            ),
          ),
        )

        return h(
          'section',
          { className: P + 'section' },
          h('style', { key: 'style' }, CSS),
          h(
            'div',
            { key: 'head' },
            h('h2', { className: P + 'h2' }, t('title')),
            h('p', { className: P + 'intro' }, t('intro')),
          ),
          h(
            'form',
            { key: 'form', className: P + 'form', onSubmit: submit },
            h(
              'div',
              { className: P + 'field' },
              h('label', { className: P + 'label', htmlFor: P + 'vm' }, t('pickVm')),
              h('select', {
                id: P + 'vm',
                className: P + 'select',
                value: selected,
                onChange: (event) => {
                  setSelected(event.target.value)
                  setManualPath('')
                },
              }, options),
            ),
            h(
              'div',
              { className: P + 'field' },
              h('label', { className: P + 'label', htmlFor: P + 'path' }, t('manualPath')),
              h('input', {
                id: P + 'path',
                className: P + 'input',
                type: 'text',
                value: manualPath,
                placeholder: 'C:\\Users\\me\\Documents\\Virtual Machines\\vm\\vm.vmx',
                onChange: (event) => setManualPath(event.target.value),
              }),
            ),
            h(
              'div',
              { className: P + 'field' },
              h('label', { className: P + 'label', htmlFor: P + 'user' }, t('user')),
              h('input', {
                id: P + 'user',
                className: P + 'input',
                type: 'text',
                value: guestUser,
                autoComplete: 'off',
                onChange: (event) => setGuestUser(event.target.value),
              }),
            ),
            h(
              'div',
              { className: P + 'field' },
              h('label', { className: P + 'label', htmlFor: P + 'password' }, t('password')),
              h('input', {
                id: P + 'password',
                className: P + 'input',
                type: 'password',
                value: guestPassword,
                autoComplete: 'new-password',
                onChange: (event) => setGuestPassword(event.target.value),
              }),
            ),
            h(
              'div',
              { className: P + 'buttons' },
              h('button', { type: 'submit', className: P + 'primary', disabled: busy || !effectiveVmx }, t('save')),
              h('button', { type: 'button', onClick: () => void refresh(), disabled: busy }, t('refresh')),
            ),
          ),
          status
            ? h('div', { key: 'status', className: `${P}status ${status.kind === 'ok' ? P + 'ok' : P + 'error'}` }, status.text)
            : null,
          entries.length === 0
            ? h('div', { key: 'empty', className: P + 'empty' }, busy ? t('loading') : t('empty'))
            : h(
                'table',
                { key: 'table', className: P + 'table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, t('columnName')),
                    h('th', null, t('columnPath')),
                    h('th', null, t('columnUser')),
                    h('th', null, t('columnPassword')),
                    h('th', null, t('columnUpdated')),
                    h('th', null, t('columnActions')),
                  ),
                ),
                h('tbody', null, rows),
              ),
        )
      }
    }

    return {
      name: 'dsh-vmware-tools',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTIONARIES.en), 'vmware-tools: locale en')
        ctx.effect(() => ctx.locale.register(NS, 'en-US', DICTIONARIES.en), 'vmware-tools: locale en-US')
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTIONARIES.zh), 'vmware-tools: locale zh')
        ctx.effect(() => ctx.locale.register(NS, 'zh-CN', DICTIONARIES.zh), 'vmware-tools: locale zh-CN')

        const Section = makeSection(ctx)
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            {
              name: 'settings.section',
              id: 'vmware-credentials',
              order: 45,
              label: () => t('title'),
            },
            Section,
          )
        })
      },
    }
  },
})
