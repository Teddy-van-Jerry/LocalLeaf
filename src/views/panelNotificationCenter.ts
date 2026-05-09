export type PanelNoticeType = 'info' | 'warning' | 'error';

export interface PanelNotificationButton {
    label: string;
    value: string;
    primary?: boolean;
    danger?: boolean;
}

export interface PanelModalRequest {
    message: string;
    type?: PanelNoticeType;
    buttons: PanelNotificationButton[];
}

export interface PanelModal extends PanelModalRequest {
    id: string;
    type: PanelNoticeType;
}

export interface PanelNotice {
    id: string;
    message: string;
    type: PanelNoticeType;
    count: number;
    revision: number;
    history: string[];
}

export interface PanelNotificationState {
    modal: PanelModal | null;
    notice: PanelNotice | null;
}

type Listener = (state: PanelNotificationState) => void;

const NOTICE_HISTORY_LIMIT = 5;
const severity: Record<PanelNoticeType, number> = {
    info: 0,
    warning: 1,
    error: 2,
};

export class PanelNotificationCenter {
    private modal: PanelModal | null = null;
    private notice: PanelNotice | null = null;
    private modalResolve?: (value: string) => void;
    private listeners = new Set<Listener>();
    private nextId = 0;

    getState(): PanelNotificationState {
        return {
            modal: this.modal ? { ...this.modal, buttons: [...this.modal.buttons] } : null,
            notice: this.notice ? { ...this.notice, history: [...this.notice.history] } : null,
        };
    }

    subscribe(listener: Listener): { dispose: () => void } {
        this.listeners.add(listener);
        listener(this.getState());
        return {
            dispose: () => this.listeners.delete(listener),
        };
    }

    showModal(request: PanelModalRequest): Promise<string> {
        if (this.modalResolve) {
            this.modalResolve('dismiss');
        }

        this.modal = {
            ...request,
            type: request.type || 'warning',
            id: `modal-${++this.nextId}`,
            buttons: [...request.buttons],
        };
        this.emit();

        return new Promise(resolve => {
            this.modalResolve = resolve;
        });
    }

    respondToModal(id: string, value: string): void {
        if (!this.modal || this.modal.id !== id) {
            return;
        }

        const resolve = this.modalResolve;
        this.modal = null;
        this.modalResolve = undefined;
        resolve?.(value);
        this.emit();
    }

    showNotice(message: string, type: PanelNoticeType): string {
        if (this.notice) {
            const history = [...this.notice.history, message]
                .filter((item, index, list) => list.indexOf(item) === index)
                .slice(-NOTICE_HISTORY_LIMIT);
            this.notice = {
                ...this.notice,
                message,
                type: severity[type] >= severity[this.notice.type] ? type : this.notice.type,
                count: this.notice.count + 1,
                revision: this.notice.revision + 1,
                history,
            };
        } else {
            this.notice = {
                id: `notice-${++this.nextId}`,
                message,
                type,
                count: 1,
                revision: 1,
                history: [message],
            };
        }

        this.emit();
        return this.notice.id;
    }

    dismissNotice(id?: string, revision?: number): void {
        if (!this.notice) {
            return;
        }
        if (id && this.notice.id !== id) {
            return;
        }
        if (revision !== undefined && this.notice.revision !== revision) {
            return;
        }
        this.notice = null;
        this.emit();
    }

    private emit(): void {
        const state = this.getState();
        for (const listener of this.listeners) {
            listener(state);
        }
    }
}
