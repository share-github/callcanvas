declare function useEffect(effect: () => void): void;

export function saveAll(): void {}
export function logError(e: Error): void {
    void e;
}
export function register(
    _opts: { onFlush: () => void; onError: (e: Error) => void }
): void {
    void _opts;
}

export function useChat(): void {
    useEffect(() => {
        const onFlush = () => {
            saveAll();
        };
        const onError = (e: Error) => {
            logError(e);
        };
        register({ onFlush, onError });
    });
}
