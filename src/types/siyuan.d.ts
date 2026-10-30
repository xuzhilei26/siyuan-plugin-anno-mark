declare module "siyuan" {
    export interface IPluginEventBus {
        on(name: string, callback: (event: any) => void): void;
        off(name: string, callback: (event: any) => void): void;
    }

    export interface IPluginOptions {
        name: string;
        app: any;
        i18n: any;
        eventBus: IPluginEventBus;
        [key: string]: any;
    }

    export class Plugin {
        name: string;
        app: any;
        i18n: any;
        eventBus: IPluginEventBus;

        constructor(options: IPluginOptions);

        addIcons(svg: string): void;
        loadData(name: string): Promise<any>;
        saveData(name: string, data: any): Promise<any>;
        removeData(name: string): Promise<any>;
        addTopBar(...args: any[]): HTMLElement;

        [key: string]: any;
    }

    export interface IDialogOptions {
        title?: string;
        content: string;
        width?: string;
        height?: string;
        destroyCallback?: () => void;
    }

    export class Dialog {
        element: HTMLElement;

        constructor(options: IDialogOptions);

        destroy(): void;
    }

    export class Menu {
        constructor(name: string, close?: () => void);

        addItem(option: any): void;
        open(position: { x: number; y: number }): void;
        close?(): void;
    }

    export function showMessage(
        msg: string,
        timeout?: number,
        type?: "info" | "error" | "warning" | "success"
    ): void;

    export function confirm(
        title: string,
        text: string,
        yes?: () => void,
        no?: () => void
    ): void;
}
