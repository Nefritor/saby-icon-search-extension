import { createRoot } from 'react-dom/client';
import '../styles.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Не найден корневой элемент #root');

createRoot(container).render(<App />);
