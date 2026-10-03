// ВАЖНО: этот импорт должен идти первым — он подменяет транспорт движка
// на локальный до того, как api.ts успеет поставить chrome-транспорт.
import './localTransport';

import { createRoot } from 'react-dom/client';
import '../styles.css';
import { App } from '../popup/App';

const container = document.getElementById('root');
if (!container) throw new Error('Не найден корневой элемент #root');

createRoot(container).render(<App />);
