import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsoleRoot } from '@sampatel3/console-ui/server';
import App from './App';
import '@sampatel3/console-ui/styles.css';
import './styles.css';
import './console-standard-adapter.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConsoleRoot product="worker" theme="light" density="compact">
      <App />
    </ConsoleRoot>
  </StrictMode>,
);
