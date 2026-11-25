/**
 * A long list that only puts the rows on screen into the page (thousands of changed files after a
 * mass rename or reformat). Short lists render normally. Rows have a fixed height.
 */
import React from 'react';

interface Props<T> {
    items: T[];
    rowHeight?: number;
    /** Lists up to this length render all rows (no inner scroll box). */
    threshold?: number;
    /** Height of the scroll box for long lists. */
    height?: number | string;
    keyOf: (item: T) => string;
    render: (item: T, index: number) => React.ReactNode;
}

export function VirtualRows<T>({ items, rowHeight = 28, threshold = 300, height = '50vh', keyOf, render }: Props<T>) {
    const box = React.useRef<HTMLDivElement>(null);
    const [top, setTop] = React.useState(0);
    const [view, setView] = React.useState(600);
    const long = items.length > threshold;
    React.useEffect(() => {
        const el = box.current; if (!el || !long) return;
        const ro = new ResizeObserver(() => setView(el.clientHeight));
        ro.observe(el);
        return () => ro.disconnect();
    }, [long]);
    if (!long) return <>{items.map((it, i) => <React.Fragment key={keyOf(it)}>{render(it, i)}</React.Fragment>)}</>;
    const overscan = 10;
    const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const last = Math.min(items.length, Math.ceil((top + view) / rowHeight) + overscan);
    return (
        <div ref={box} style={{ height, overflow: 'auto', position: 'relative' }} onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)}>
            <div style={{ height: items.length * rowHeight, position: 'relative' }}>
                {items.slice(first, last).map((it, i) => (
                    <div key={keyOf(it)} style={{ position: 'absolute', top: (first + i) * rowHeight, left: 0, right: 0, height: rowHeight }}>{render(it, first + i)}</div>
                ))}
            </div>
        </div>
    );
}
