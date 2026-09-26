// Panel styles. Colors come from ComfyUI's palette variables so everything
// follows the active theme.

export const STYLES = `
.rs-host { height: 100%; overflow: hidden; }
.rs-panel, .rs-panel-vars {
  --rs-bg: var(--comfy-menu-bg, #202020);
  --rs-bg2: var(--comfy-input-bg, #2a2a2a);
  --rs-fg: var(--fg-color, #ddd);
  --rs-muted: var(--descrip-text, #999);
  --rs-border: var(--border-color, #3a3a3a);
  --rs-accent: var(--p-primary-color, #3b82f6);
  --rs-accent-fg: var(--p-primary-contrast-color, #fff);
  --rs-soft: color-mix(in srgb, var(--rs-border) 55%, transparent);
  color: var(--rs-fg); font-size: 13px; line-height: 1.4;
}
.rs-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }

/* header */
.rs-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; }
.rs-title { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.rs-logo { width: 28px; height: 28px; border-radius: 7px; flex: none; display: block;
  background: linear-gradient(135deg, #3b82f6, #a855f7); color: #fff; font-weight: 800; font-size: 14px; }
.rs-title-text { min-width: 0; }
.rs-title-name { font-weight: 650; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-status { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--rs-muted); }
.rs-dot { width: 7px; height: 7px; border-radius: 50%; background: #888; }
.rs-status-online .rs-dot { background: #22c55e; box-shadow: 0 0 0 3px rgb(34 197 94 / .18); }
.rs-status-connecting .rs-dot { background: #eab308; }
.rs-status-offline .rs-dot, .rs-status-denied .rs-dot { background: #ef4444; }
.rs-me-btn { border: 2px solid transparent; background: none; padding: 1px; border-radius: 50%; cursor: pointer; }
.rs-me-btn:hover, .rs-me-btn.active { border-color: var(--rs-accent); }

/* tabs */
.rs-nav { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--rs-border); }
.rs-tab { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 2px; position: relative;
  padding: 6px 2px 7px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--rs-muted);
  font: inherit; font-size: 10.5px; cursor: pointer; }
.rs-tab .pi { font-size: 15px; }
.rs-tab:hover { color: var(--rs-fg); }
.rs-tab.active { color: var(--rs-fg); border-bottom-color: var(--rs-accent); }
.rs-tab-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-count { position: absolute; top: 2px; left: calc(50% + 6px); min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px;
  background: var(--rs-bg2); color: var(--rs-muted); font-size: 9.5px; line-height: 15px; font-weight: 600; }
.rs-count.hot { background: #ef4444; color: #fff; }

/* body + sections */
.rs-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 14px; }
.rs-body-chat { display: flex; flex-direction: column; overflow: hidden; padding-bottom: 10px; }
.rs-section { margin-bottom: 14px; }
.rs-section-title { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; color: var(--rs-muted);
  font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; }
.rs-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 10px; color: var(--rs-muted); text-align: center; }
.rs-muted { color: var(--rs-muted); }
.rs-hint { max-width: 260px; line-height: 1.5; }
.rs-access { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; }
.rs-access .pi { color: var(--rs-muted); }
.rs-btn-sm { padding: 3px 9px; font-size: 11px; }
.rs-access-editor { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--rs-border); border-radius: 8px; background: color-mix(in srgb, var(--rs-bg2) 50%, transparent); }
.rs-access-list { margin-top: 8px; max-height: 240px; overflow-y: auto; }
.rs-input.rs-select { width: auto; flex: none; padding: 4px 6px; font-size: 12px; }
.rs-small { font-size: 11px; }
.rs-section p { margin: 4px 0 8px; }
.rs-note { display: flex; gap: 6px; align-items: center; color: var(--rs-muted); font-size: 12px; }
.rs-grow { flex: 1; }
.rs-min0 { min-width: 0; }
.rs-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-row { display: flex; gap: 6px; align-items: center; }
.rs-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
code { font-family: ui-monospace, monospace; font-size: 11px; background: var(--rs-bg2); padding: 1px 4px; border-radius: 4px; }

/* list rows */
.rs-row-item { display: flex; align-items: center; gap: 10px; padding: 7px 6px; border-radius: 6px; }
.rs-row-item + .rs-row-item { border-top: 1px solid var(--rs-soft); }
.rs-row-icon { color: var(--rs-muted); flex: none; width: 16px; text-align: center; }
.rs-room { cursor: default; }
.rs-room.here { background: color-mix(in srgb, var(--rs-accent) 12%, transparent); }
.rs-where { display: flex; align-items: center; gap: 5px; margin-top: 3px; color: var(--rs-muted); font-size: 11px; min-width: 0; }
.rs-where .pi { font-size: 10px; flex: none; }
.rs-inline-icon { margin-left: 6px; font-size: 11px; }

/* this tab */
.rs-tab-head { display: flex; align-items: center; gap: 8px; }
.rs-tab-head .rs-name { font-size: 14px; }
.rs-live-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.rs-live { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; }
.rs-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; animation: rs-pulse 1.6s infinite; flex: none; }
@keyframes rs-pulse { 50% { opacity: .35; } }
.rs-history { margin-top: 8px; max-height: 260px; overflow-y: auto; border: 1px solid var(--rs-soft); border-radius: 8px; padding: 2px 4px; }

/* avatars, chips */
.rs-avatar { width: 30px; height: 30px; border-radius: 50%; flex: none; display: inline-grid; place-items: center;
  font-weight: 700; color: #111; font-size: 11px; }
.rs-avatar-sm { width: 28px; height: 28px; font-size: 10.5px; }
.rs-avatar-lg { width: 44px; height: 44px; font-size: 15px; }
.rs-avatar-xs { width: 20px; height: 20px; font-size: 8.5px; }
.rs-avatars { display: inline-flex; gap: 3px; flex-wrap: wrap; margin-top: 3px; }
.rs-name { font-weight: 600; }
.rs-me { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.rs-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.rs-chip { font-size: 10px; line-height: 16px; padding: 0 7px; border-radius: 999px; border: 1px solid var(--rs-border); color: var(--rs-muted); white-space: nowrap; }
.rs-chip-admin { border-color: #f59e0b; color: #f59e0b; }
.rs-chip-edit { border-color: #22c55e; color: #22c55e; }
.rs-chip-queue { border-color: #38bdf8; color: #38bdf8; }
.rs-chip-manager { border-color: #c084fc; color: #c084fc; }
.rs-wrap { flex-wrap: wrap; }
/* Comfy.org account sign-in hidden by the admin */
body.rs-hide-comfy-account [data-testid="login-button"],
body.rs-hide-comfy-account [data-testid="login-button-popover"] { display: none !important; }
/* ComfyUI Manager hidden for accounts without the "manager" permission */
body.rs-no-manager .comfyui-button-group:has(> [title="ComfyUI Manager"]),
body.rs-no-manager [title="ComfyUI Manager"],
body.rs-no-manager [aria-label="ComfyUI Manager"] { display: none !important; }
.rs-toggle { font-size: 10px; line-height: 16px; padding: 0 8px; border-radius: 999px; border: 1px dashed var(--rs-border); background: none; color: var(--rs-muted); cursor: pointer; }
.rs-toggle.on { border-style: solid; border-color: #22c55e; color: #22c55e; }
.rs-toggle:hover { border-color: var(--rs-accent); }
.rs-toggle.locked { opacity: .55; cursor: default; }
.rs-toggle.locked:hover { border-color: #22c55e; }

/* controls */
.rs-form { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.rs-label { font-size: 11px; color: var(--rs-muted); margin-top: 4px; }
.rs-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--rs-border);
  background: var(--rs-bg2); color: var(--rs-fg); font: inherit; }
.rs-input:focus { outline: none; border-color: var(--rs-accent); }
.rs-num { width: 70px; flex: none; }
.rs-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--rs-border);
  background: var(--rs-bg2); color: var(--rs-fg); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.rs-btn:hover:not(:disabled), .rs-btn.active { border-color: var(--rs-accent); }
.rs-btn.active { color: var(--rs-accent); }
.rs-btn:disabled { opacity: .5; cursor: default; }
.rs-btn-primary, .rs-btn-primary.active { background: var(--rs-accent); border-color: var(--rs-accent); color: var(--rs-accent-fg); }
.rs-btn-ghost { background: none; }
.rs-btn-icon { padding: 5px 7px; flex: none; }
.rs-danger:hover { border-color: #ef4444 !important; color: #ef4444; }
.rs-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; }
.rs-block { display: flex; align-items: flex-start; margin-top: 4px; }
.rs-block input { margin-top: 3px; }
.rs-details { margin-top: 8px; border: 1px dashed var(--rs-border); border-radius: 8px; padding: 6px 8px; }
.rs-details summary { cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12px; list-style: none; }
.rs-details summary::-webkit-details-marker { display: none; }
.rs-newkey { border: 1px solid #22c55e; border-radius: 8px; padding: 8px; margin: 6px 0; background: rgb(34 197 94 / .08); }
.rs-keytext { word-break: break-all; padding: 4px 6px; }

/* chat */
.rs-chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rs-chat-log { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 2px 2px 8px; }
.rs-msg { max-width: 92%; }
.rs-msg-head { display: flex; align-items: baseline; gap: 6px; }
.rs-msg-name { font-weight: 650; font-size: 12px; }
.rs-msg-text { margin-top: 2px; padding: 6px 9px; border-radius: 4px 10px 10px 10px; background: var(--rs-bg2);
  font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; width: fit-content; max-width: 100%; }
.rs-msg.mine { align-self: flex-end; }
.rs-msg.mine .rs-msg-head { justify-content: flex-end; }
.rs-msg.mine .rs-msg-text { border-radius: 10px 4px 10px 10px; background: color-mix(in srgb, var(--rs-accent) 22%, var(--rs-bg2)); margin-left: auto; }
.rs-msg-system { align-self: center; color: var(--rs-muted); font-size: 11px; font-style: italic; }
.rs-time { color: var(--rs-muted); font-size: 10px; font-variant-numeric: tabular-nums; margin-right: 4px; }
.rs-chat-top { display: flex; justify-content: center; align-items: center; min-height: 28px; flex: none; }
.rs-chat-day { display: flex; align-items: center; gap: 8px; color: var(--rs-muted); font-size: 11px; flex: none; }
.rs-chat-day::before, .rs-chat-day::after { content: ""; flex: 1; border-top: 1px solid var(--rs-border); }
.rs-chat-compose { display: flex; gap: 6px; align-items: flex-end; border-top: 1px solid var(--rs-border); padding-top: 8px; }
.rs-chat-input { resize: none; max-height: 120px; min-height: 32px; }

/* server */
.rs-meter { margin-top: 7px; }
.rs-meter-top { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; }
.rs-meter-track { height: 6px; border-radius: 3px; background: var(--rs-bg2); overflow: hidden; }
.rs-meter-fill { display: block; height: 100%; border-radius: 3px; background: #22c55e; transition: width .6s ease; }
.rs-meter-fill.warm { background: #eab308; }
.rs-meter-fill.hot { background: #ef4444; }
.rs-gpu + .rs-gpu { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--rs-soft); }
.rs-gpu-name { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 600; flex-wrap: wrap; }
.rs-gpu-name .rs-muted { font-weight: 400; font-size: 11px; }
.rs-queue-line { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 6px 8px; border-radius: 6px; background: var(--rs-bg2); }

/* files */
.rs-folder-block + .rs-folder-block { border-top: 1px solid var(--rs-soft); }
.rs-folder-files { margin-left: 26px; }
.rs-file .rs-select { max-width: 110px; }

/* file browser */
.rs-files-logo { width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; font-size: 15px;
  background: linear-gradient(135deg, #3b82f6, #a855f7); color: #fff; flex: none; }
.rs-fb { display: flex; flex-direction: column; min-height: 0; }
.rs-fb-tabs { display: flex; gap: 2px; margin-bottom: 8px; border-bottom: 1px solid var(--rs-border); }
.rs-fb-tab { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 6px; border: 0;
  border-bottom: 2px solid transparent; margin-bottom: -1px; background: none; color: var(--rs-muted); font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.rs-fb-tab span { overflow: hidden; text-overflow: ellipsis; }
.rs-fb-tab:hover { color: var(--rs-fg); }
.rs-fb-tab.active { color: var(--rs-fg); border-bottom-color: var(--rs-accent); font-weight: 600; }
.rs-fb-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.rs-fb-crumbs { flex: 1; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
.rs-fb-crumb { border: 0; background: none; color: var(--rs-muted); font: inherit; font-size: 12.5px; padding: 3px 5px; border-radius: 5px; cursor: pointer; }
.rs-fb-crumb:hover { color: var(--rs-fg); background: var(--rs-bg2); }
.rs-fb-crumb.current { color: var(--rs-fg); font-weight: 650; }
.rs-fb-sep { font-size: 10px; color: var(--rs-muted); }
.rs-fb-actions { display: flex; gap: 4px; }
.rs-fb-tools { margin-bottom: 6px; }
.rs-fb-search { padding: 5px 8px; font-size: 12px; }
.rs-fb-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 60px; }
.rs-fb-row { display: flex; align-items: center; gap: 6px; border-radius: 7px; position: relative; }
.rs-fb-row:hover { background: color-mix(in srgb, var(--rs-bg2) 70%, transparent); }
.rs-fb-row.disabled { opacity: .45; }
.rs-fb-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 7px 8px; border: 0; background: none;
  color: inherit; font: inherit; text-align: left; cursor: pointer; }
.rs-fb-main:disabled { cursor: default; }
.rs-fb-icon { font-size: 16px; color: var(--rs-muted); width: 18px; text-align: center; flex: none; }
.rs-fb-icon.folder { color: #f5b942; }
.rs-fb-tools-row { display: none; gap: 3px; padding-right: 6px; }
.rs-fb-row:hover .rs-fb-tools-row, .rs-fb-row:focus-within .rs-fb-tools-row { display: flex; }
.rs-fb-empty { color: var(--rs-muted); font-size: 12px; text-align: center; padding: 24px 8px; }
.rs-modal-wide { max-width: 560px; }
.rs-modal-wide .rs-fb-list { max-height: 46vh; }
.rs-modal-footer { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--rs-border); }
.rs-save-body { display: flex; flex-direction: column; gap: 6px; }
.rs-save-body .rs-fb { border: 1px solid var(--rs-border); border-radius: 8px; padding: 8px; }

/* save dialog */
.rs-modal-backdrop { position: fixed; inset: 0; z-index: 3000; background: rgb(0 0 0 / .55); display: grid; place-items: center; padding: 16px; color: var(--rs-fg); font-size: 13px; }
.rs-modal { width: 100%; max-width: 440px; max-height: 90vh; overflow-y: auto; background: var(--rs-bg); border: 1px solid var(--rs-border);
  border-radius: 12px; padding: 18px 18px 14px; box-shadow: 0 20px 60px rgb(0 0 0 / .45); display: flex; flex-direction: column; gap: 6px; }
.rs-modal-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 650; margin-bottom: 6px; }
.rs-modal-actions { justify-content: flex-end; margin-top: 10px; }
.rs-save-list { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto; margin-bottom: 6px; }
.rs-save-option { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border: 1px solid var(--rs-border); border-radius: 8px; cursor: pointer; }
.rs-save-option.on { border-color: var(--rs-accent); background: color-mix(in srgb, var(--rs-accent) 12%, transparent); }
.rs-save-option input { margin: 0; }
.rs-error { color: #f87171; font-size: 12px; }
.rs-error:empty { display: none; }

/* floating server monitor */
.rs-float { position: fixed; z-index: 1000; width: 240px; background: var(--rs-bg); border: 1px solid var(--rs-border);
  border-radius: 10px; box-shadow: 0 10px 30px rgb(0 0 0 / .35); font-size: 11px; user-select: none; }
.rs-float-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: grab; border-bottom: 1px solid var(--rs-border);
  font-weight: 600; font-size: 11px; }
.rs-float-head:active { cursor: grabbing; }
.rs-float-close { border: 0; background: none; color: var(--rs-muted); cursor: pointer; padding: 2px; }
.rs-float-close:hover { color: var(--rs-fg); }
.rs-float-body { padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 4px; }
.rs-mini { display: grid; grid-template-columns: 46px 1fr 62px; align-items: center; gap: 6px; }
.rs-mini-label { color: var(--rs-muted); }
.rs-mini-track { height: 5px; border-radius: 3px; background: var(--rs-bg2); overflow: hidden; }
.rs-mini-text { text-align: right; font-variant-numeric: tabular-nums; }
.rs-mini-queue { color: var(--rs-muted); text-align: center; margin-top: 2px; }

/* remote cursors (DOM layer above canvas content) */
.rs-dock { position: fixed; left: 64px; bottom: 16px; z-index: 1100; display: flex; gap: 4px; padding: 4px;
  background: var(--rs-bg); border: 1px solid var(--rs-border); border-radius: 12px; box-shadow: 0 6px 24px rgb(0 0 0 / .35); }
.rs-dock-btn { position: relative; width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 8px;
  background: none; color: var(--rs-muted); cursor: pointer; }
.rs-dock-btn .pi { font-size: 16px; }
.rs-dock-btn:hover { color: var(--rs-fg); background: var(--rs-bg2); }
.rs-dock-btn.active { color: var(--rs-accent-fg); background: var(--rs-accent); }
.rs-dock-badge { display: none; position: absolute; top: 1px; right: 1px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: #ef4444; color: #fff; font-size: 10px; line-height: 16px; font-weight: 700; }
.rs-dock-drawer { position: fixed; top: 8px; bottom: 64px; left: 64px; width: min(380px, calc(100vw - 80px)); z-index: 1100;
  background: var(--rs-bg); border: 1px solid var(--rs-border); border-radius: 12px; box-shadow: 0 12px 40px rgb(0 0 0 / .45); overflow: hidden; }
.rs-dock-drawer-body { height: 100%; }
.rs-dock-drawer .rs-header { padding-right: 40px; }
.rs-rail-badge { position: absolute; top: -4px; right: -6px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: #ef4444; color: #fff; font-size: 10px; line-height: 16px; font-weight: 700; text-align: center; }
.rs-dock-close { position: absolute; top: 8px; right: 8px; z-index: 2; border: 0; background: none; color: var(--rs-muted); cursor: pointer; padding: 4px; }
.rs-dock-close:hover { color: var(--rs-fg); }
.rs-cursor-layer { position: fixed; inset: 0; pointer-events: none; z-index: 900; overflow: hidden; }
.rs-cursor { position: absolute; left: 0; top: 0; will-change: transform; transition: transform 70ms linear; }
.rs-cursor svg { display: block; filter: drop-shadow(0 1px 1px rgb(0 0 0 / .4)); }
.rs-cursor-name { position: absolute; left: 13px; top: 17px; padding: 1px 6px; border-radius: 4px; color: #111;
  font: 600 11px/16px system-ui, sans-serif; white-space: nowrap; }

/* sidebar icon blink for unread chat */
@keyframes rigshare-blink { 0%, 100% { box-shadow: none; } 50% { box-shadow: inset 0 0 0 2px var(--p-primary-color, #3b82f6); background: color-mix(in srgb, var(--p-primary-color, #3b82f6) 25%, transparent); } }
.rigshare-blink { animation: rigshare-blink 1.1s ease-in-out infinite; border-radius: 8px; }
.rigshare-blink .rigshare-tab-icon { color: var(--p-primary-color, #3b82f6); }
`;
