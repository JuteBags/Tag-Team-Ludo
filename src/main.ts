import './ui/fonts.css';
import './ui/styles.css';
import { mountApp } from './ui/app';

const pattern = `<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56' viewBox='0 0 56 56'><g fill='none' stroke='#a8c8ff' stroke-opacity='.09' stroke-width='2'><rect x='15' y='15' width='26' height='26' rx='6' transform='rotate(45 28 28)'/><path d='M0 0l7 7M56 0l-7 7M0 56l7-7M56 56l-7-7'/></g><circle cx='28' cy='28' r='3' fill='#a8c8ff' fill-opacity='.10'/></svg>`;
document.documentElement.style.setProperty('--pat', `url("data:image/svg+xml,${encodeURIComponent(pattern)}")`);

mountApp(document.getElementById('app')!);
