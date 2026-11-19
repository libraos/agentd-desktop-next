# 958 Cloud key file picker

- `apps/desktop/src/ipc/channels.ts` registers the native file picker channel name.
- `apps/desktop/src/ipc/DesktopIpcHandlers.ts` wires the file picker handler.
- `apps/desktop/src/ipc/methods/window.ts` reuses Electron’s single-file dialog without image filters.
- `apps/desktop/src/ipc/methods/window.test.ts` checks the file picker’s selection and cancellation.
- `apps/desktop/src/preload.ts` exposes the file picker to the renderer.
- `packages/contracts/src/ipc.ts` types the file picker on the desktop bridge.
- `apps/web/src/i18n/translations/de.json` adds the key file picker text and validation messages.
- `apps/web/src/i18n/translations/en.json` adds the key file picker text and validation messages.
- `apps/web/src/i18n/translations/es.json` adds the key file picker text and validation messages.
- `apps/web/src/i18n/translations/fr.json` adds the key file picker text and validation messages.
- `apps/web/src/i18n/translations/ja.json` adds the key file picker text and validation messages.
- `apps/web/src/i18n/translations/ko.json` adds the key file picker text and validation messages.
- `apps/web/src/i18n/translations/pt-BR.json` adds the key file picker text and validation messages.
- `apps/web/src/i18n/translations/ru.json` adds the key file picker text and validation messages.
- `apps/web/src/i18n/translations/sv.json` adds the key file picker text and validation messages.
- `apps/web/src/i18n/translations/zh.json` adds the key file picker text and validation messages.
