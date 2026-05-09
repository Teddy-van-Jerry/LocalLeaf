export interface SyncOperationStarted<T> {
    started: true;
    result: T;
}

export interface SyncOperationBusy {
    started: false;
    activeOperation: string;
}

export type SyncOperationResult<T> = SyncOperationStarted<T> | SyncOperationBusy;

export class SyncOperationGate {
    private activeOperation?: string;

    get active(): string | undefined {
        return this.activeOperation;
    }

    async tryRun<T>(operationName: string, operation: () => Promise<T>): Promise<SyncOperationResult<T>> {
        if (this.activeOperation) {
            return {
                started: false,
                activeOperation: this.activeOperation,
            };
        }

        this.activeOperation = operationName;
        try {
            return {
                started: true,
                result: await operation(),
            };
        } finally {
            this.activeOperation = undefined;
        }
    }
}
