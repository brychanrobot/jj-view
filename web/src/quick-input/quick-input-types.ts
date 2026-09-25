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
    value?: T;
    alwaysShow?: boolean;
}

export type InputBoxValidationMessage = string | null | undefined;

export interface InputBoxOptions {
    title?: string;
    prompt?: string;
    value?: string;
    placeHolder?: string;
    password?: boolean;
    validateInput?: (value: string) => InputBoxValidationMessage | Promise<InputBoxValidationMessage>;
}

export interface QuickPickOptions<T = unknown> {
    title?: string;
    placeHolder?: string;
    items: QuickPickItem<T>[];
    canSelectMany?: boolean;
    matchOnDescription?: boolean;
    matchOnDetail?: boolean;
    acceptCustomValue?: boolean;
}

export type QuickInputSession =
    | {
          type: 'input-box';
          options: InputBoxOptions;
          resolve: (value: string | undefined) => void;
      }
    | {
          type: 'quick-pick';
          options: QuickPickOptions;
          resolve: (value: QuickPickItem | undefined) => void;
      }
    | {
          type: 'multi-quick-pick';
          options: QuickPickOptions;
          resolve: (value: QuickPickItem[] | undefined) => void;
      };
