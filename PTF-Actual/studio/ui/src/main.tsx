import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import { StudioApp } from './App';
import './styles.css';

function Root() {
    const prefersDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const [dark, setDark] = React.useState<boolean>(() => {
        try { const v = localStorage.getItem('cs-studio-theme'); if (v) return v === 'dark'; } catch { /* ignore */ }
        return prefersDark;
    });
    const toggle = () => setDark((d) => { try { localStorage.setItem('cs-studio-theme', d ? 'light' : 'dark'); } catch { /* ignore */ } return !d; });
    React.useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
    return (
        <ConfigProvider theme={{
            algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
            token: { colorPrimary: '#93186C', borderRadius: 6, fontSize: 13 },
        }}>
            {/* Toasts below the 56 px top bar (never over its buttons) and for the usual 3 s, at most 3 at once. */}
            <AntApp message={{ top: 64, duration: 3, maxCount: 3 }}>
                <StudioApp dark={dark} onToggleTheme={toggle} />
            </AntApp>
        </ConfigProvider>
    );
}

createRoot(document.getElementById('root')!).render(<Root />);
