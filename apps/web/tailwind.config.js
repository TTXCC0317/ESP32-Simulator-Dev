/** @type {import('tailwindcss').Config} */
// 颜色全部映射 04-§11 CSS Variables token（双主题由 [data-theme] 切换，见 src/styles/tokens.css）；
// Tailwind 只承担布局/间距工具类，不写死颜色。
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        panel: 'var(--panel)',
        'panel-border': 'var(--panel-border)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        accent: 'var(--accent)',
        success: 'var(--success)',
        warn: 'var(--warn)',
        danger: 'var(--danger)',
        grid: 'var(--grid)',
        'pin-stroke': 'var(--pin-stroke)',
        'led-off': 'var(--led-off)',
      },
    },
  },
  plugins: [],
};
