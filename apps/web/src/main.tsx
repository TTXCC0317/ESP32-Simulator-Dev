import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { applyTheme, useUiStore } from './stores/ui';

// 启动兜底：持久化主题 → html[data-theme]（index.html 内联脚本已先行处理，此处覆盖异常路径）
applyTheme(useUiStore.getState().theme);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
