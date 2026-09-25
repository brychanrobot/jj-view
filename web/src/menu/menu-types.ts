/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RawCommandContribution {
    readonly command: string;
    readonly title: string;
    readonly category?: string;
    readonly icon?: string | { light?: string; dark?: string };
}

export interface RawMenuItemContribution {
    readonly command: string;
    readonly when?: string;
    readonly group?: string;
}

export interface PackageJsonContributes {
    readonly commands?: readonly RawCommandContribution[];
    readonly menus?: Readonly<Record<string, readonly RawMenuItemContribution[]>>;
}

export interface ResolvedMenuItem {
    readonly command: string;
    readonly title: string;
    readonly category?: string;
    readonly iconClass?: string;
    readonly groupName: string;
    readonly order: number;
    readonly isInline: boolean;
    readonly when?: string;
}

export interface ResolvedMenuItemGroup {
    readonly groupName: string;
    readonly items: readonly ResolvedMenuItem[];
}
