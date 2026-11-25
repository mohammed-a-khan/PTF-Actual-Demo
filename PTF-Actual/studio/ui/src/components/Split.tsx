/**
 * Two panes with a draggable divider. The size of the first pane (or of the second, with
 * `sizeOf="second"`) is remembered per `id`, in pixels. Double-click the divider to reset it.
 * Keyboard: focus the divider and use the arrow keys.
 */
import React from 'react';

interface Props {
    id: string;
    /** 'row': side by side (divider is vertical); 'column': one above the other. */
    direction?: 'row' | 'column';
    initial: number;
    min?: number;
    max?: number;
    /** Which pane has the fixed (remembered) size; the other one takes the rest. */
    sizeOf?: 'first' | 'second';
    children: [React.ReactNode, React.ReactNode];
    style?: React.CSSProperties;
}

const KEY = (id: string) => `cs-studio-split-${id}`;

export function Split({ id, direction = 'row', initial, min = 120, max = 1200, sizeOf = 'first', children, style }: Props) {
    const [size, setSize] = React.useState<number>(() => {
        try { const v = Number(localStorage.getItem(KEY(id))); if (v >= min && v <= max) return v; } catch { /* ignore */ }
        return initial;
    });
    const box = React.useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = React.useState(false);
    const save = (v: number) => { try { localStorage.setItem(KEY(id), String(Math.round(v))); } catch { /* ignore */ } };
    const clamp = (v: number) => {
        const total = box.current ? (direction === 'row' ? box.current.clientWidth : box.current.clientHeight) : Infinity;
        // Always leave at least `min` for the other pane too.
        return Math.max(min, Math.min(max, total - min - 6, v));
    };

    const onDown = (e: React.PointerEvent) => {
        e.preventDefault();
        const el = box.current; if (!el) return;
        const rect = el.getBoundingClientRect();
        setDragging(true);
        const move = (ev: PointerEvent) => {
            const pos = direction === 'row' ? ev.clientX - rect.left : ev.clientY - rect.top;
            const total = direction === 'row' ? rect.width : rect.height;
            setSize(clamp(sizeOf === 'first' ? pos : total - pos));
        };
        const up = () => {
            setDragging(false);
            window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
            setSize((v) => { save(v); return v; });
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
    const onKey = (e: React.KeyboardEvent) => {
        const grow: Record<string, number> = direction === 'row' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 };
        const d = grow[e.key];
        if (!d) return;
        e.preventDefault();
        setSize((v) => { const n = clamp(v + d * (sizeOf === 'first' ? 1 : -1) * (e.shiftKey ? 60 : 20)); save(n); return n; });
    };

    const fixed: React.CSSProperties = direction === 'row' ? { width: size, flex: 'none', minWidth: 0 } : { height: size, flex: 'none', minHeight: 0 };
    const rest: React.CSSProperties = { flex: 1, minWidth: 0, minHeight: 0 };
    const pane = (s: React.CSSProperties, c: React.ReactNode) => <div style={{ ...s, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{c}</div>;
    return (
        <div ref={box} className={`split split-${direction}${dragging ? ' dragging' : ''}`} style={{ display: 'flex', flexDirection: direction, minHeight: 0, minWidth: 0, flex: 1, ...style }}>
            {pane(sizeOf === 'first' ? fixed : rest, children[0])}
            <div className="split-handle" role="separator" aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'} tabIndex={0}
                title="Drag to resize (double-click to reset)" onPointerDown={onDown} onKeyDown={onKey}
                onDoubleClick={() => { setSize(initial); save(initial); }} />
            {pane(sizeOf === 'first' ? rest : fixed, children[1])}
        </div>
    );
}
