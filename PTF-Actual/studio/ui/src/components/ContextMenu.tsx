/**
 * The Studio's own right-click menu: an antd menu at the mouse (or caret) position instead of the
 * browser's. Keyboard: ↑/↓ move, Enter picks, Esc closes (focus goes back where it was).
 */
import React from 'react';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import type { MenuEntry } from '../contextMenus';

export interface MenuRequest {
    x: number;
    y: number;
    entries: MenuEntry[];
    /** Picked an item without its own onClick. */
    onPick?: (key: string) => void;
    /** Closed without a pick (Esc, a click outside): e.g. give the focus back. */
    onDismiss?: () => void;
    /** Screen-reader name of the menu. */
    label?: string;
}

/** A right-click menu for a screen part: `show` opens it; render `element` once. */
export function useContextMenu(): { show: (r: MenuRequest) => void; hide: () => void; element: React.ReactNode; open: boolean } {
    const [req, setReq] = React.useState<(MenuRequest & { n: number }) | null>(null);
    const n = React.useRef(0);
    const show = React.useCallback((r: MenuRequest) => setReq({ ...r, n: ++n.current }), []);
    const hide = React.useCallback(() => setReq(null), []);
    const element = req ? <ContextMenu key={req.n} req={req} onClosed={() => setReq((cur) => (cur?.n === req.n ? null : cur))} /> : null;
    return { show, hide, element, open: !!req };
}

function ContextMenu({ req, onClosed }: { req: MenuRequest; onClosed: () => void }) {
    const picked = React.useRef(false);
    // The keyboard goes to the menu as soon as it shows (↑/↓, Enter, Esc work at once).
    const box = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        let n = 0, raf = 0;
        const tryFocus = () => {
            const list = box.current?.querySelector<HTMLElement>('[role="menu"]');
            if (list) list.focus({ preventScroll: true });
            else if (n++ < 20) raf = requestAnimationFrame(tryFocus);
        };
        raf = requestAnimationFrame(tryFocus);
        return () => cancelAnimationFrame(raf);
    }, []);
    const items: MenuProps['items'] = req.entries.map((e, i) => (e === 'divider'
        ? { type: 'divider' as const, key: `-${i}` }
        : { key: e.key, label: e.label, extra: e.shortcut ? <span className="ctx-key" aria-hidden>{e.shortcut}</span> : undefined, disabled: e.disabled, danger: e.danger, 'aria-keyshortcuts': e.shortcut, 'data-key': e.key } as NonNullable<MenuProps['items']>[number]));
    return (
        <Dropdown open trigger={['contextMenu']} placement="bottomLeft"
            onOpenChange={(o) => { if (!o) { onClosed(); if (!picked.current) req.onDismiss?.(); } }}
            popupRender={(node) => <div className="ctx-menu" ref={box} onContextMenu={(e) => e.preventDefault()}>{node}</div>}
            menu={{
                items, role: 'menu', 'aria-label': req.label ?? 'Actions',
                onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation();
                    picked.current = true;
                    onClosed();
                    const e = req.entries.find((x): x is Exclude<MenuEntry, 'divider'> => x !== 'divider' && x.key === key);
                    if (!e || e.disabled) return;
                    if (e.onClick) e.onClick(); else req.onPick?.(key);
                },
            } as MenuProps}>
            <span aria-hidden style={{ position: 'fixed', left: req.x, top: req.y, width: 1, height: 1, pointerEvents: 'none' }} />
        </Dropdown>
    );
}
