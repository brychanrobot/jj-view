/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface QuickPickItem<T = unknown> {
    id: string;
    label: string;
    description?: string;
    detail?: string;
    iconClass?: string;
    filterText?: string;
    value?: T;
    alwaysShow?: boolean;
}

export type InputBoxValidationMessage = string | null | undefined;

export interface InputBoxContextAttachment {
    label: string;
    detail?: string;
    snippet: string;
}

export interface InputBoxOptions {
    title?: string;
    prompt?: string;
    value?: string;
    placeHolder?: string;
    password?: boolean;
    contextAttachment?: InputBoxContextAttachment;
    validateInput?: (value: string) => InputBoxValidationMessage | Promise<InputBoxValidationMessage>;
}

export interface QuickPickOptions<T = unknown> {
    title?: string;
    placeHolder?: string;
    items: QuickPickItem<T>[];
    canSelectMany?: boolean;
    matchOnDescription?: boolean;
    matchOnDetail?: boolean;
    preserveOrder?: boolean;
    acceptCustomValue?: boolean;
    activeItem?: QuickPickItem<T>;
    onDidChangeActive?: (items: readonly QuickPickItem<T>[]) => void;
    onDidChangeValue?: (value: string) => void;
}

export type QuickInputSession =
    | {
          sessionId?: number;
          type: 'input-box';
          options: InputBoxOptions;
          resolve: (value: string | undefined) => void;
      }
    | {
          sessionId?: number;
          type: 'quick-pick';
          options: QuickPickOptions;
          resolve: (value: QuickPickItem | undefined) => void;
      }
    | {
          sessionId?: number;
          type: 'multi-quick-pick';
          options: QuickPickOptions;
          resolve: (value: QuickPickItem[] | undefined) => void;
      };
