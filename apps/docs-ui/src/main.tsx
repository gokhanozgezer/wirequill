import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('WireQuill docs UI could not find its mount point.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
