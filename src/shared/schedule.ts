/**
 * Кооперативная отдача управления.
 *
 * Тяжёлые проходы (сканирование шрифта, построение дескрипторов глифов) идут
 * тысячами шагов подряд. Если выполнять их одним синхронным куском, поток движка
 * подвисает: на стенде разработчика это тот же поток, что и интерфейс, а в
 * расширении — offscreen-поток, который перестаёт отвечать на поиск до конца
 * индексации. Периодический выход в событийный цикл оставляет поток живым.
 */

type YieldableScheduler = { yield?: () => Promise<void> };

/**
 * Отдаёт управление событийному циклу, не дожидаясь кадра.
 *
 * `MessageChannel` — макрозадача без 4-мс зажима `setTimeout(0)`, поэтому очередь
 * сообщений движка (поиск, список шрифтов) успевает выполниться между порциями.
 * Канал создаётся на каждый вызов: несколько асинхронных потоков могут отдавать
 * управление одновременно, и общий канал перетёр бы чужие обработчики.
 */
export function yieldToEventLoop(): Promise<void> {
    const scheduler = (globalThis as { scheduler?: YieldableScheduler }).scheduler;
    if (typeof scheduler?.yield === 'function') return scheduler.yield();

    return new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });
}
