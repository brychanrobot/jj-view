/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IContextKeyService } from './context-key-service';
import { DEFAULT_PACKAGE_JSON_CONTRIBUTES } from './default-menus';
import type {
    PackageJsonContributes,
    RawCommandContribution,
    RawMenuItemContribution,
    ResolvedMenuItem,
    ResolvedMenuItemGroup,
} from './menu-types';
import { WhenEvaluator } from './when-evaluator';

export function resolveIconClass(icon: string | { light?: string; dark?: string } | undefined): string | undefined {
    if (!icon) {
        return undefined;
    }
    const iconStr = typeof icon === 'string' ? icon : (icon.dark ?? icon.light);
    if (!iconStr) {
        return undefined;
    }

    const match = iconStr.match(/^\$\(([^)]+)\)$/);
    if (!match) {
        return iconStr;
    }

    const name = match[1];
    if (name.startsWith('jj-icon-')) {
        return `codicon ${name}`;
    }
    return `codicon codicon-${name}`;
}

export interface ParsedGroup {
    readonly groupName: string;
    readonly order: number;
    readonly isInline: boolean;
}

export function parseMenuGroup(groupStr: string | undefined): ParsedGroup {
    if (!groupStr || groupStr.trim() === '') {
        return { groupName: 'default', order: 0, isInline: false };
    }

    const parts = groupStr.trim().split('@');
    const groupName = parts[0] || 'default';
    const order = parts.length > 1 ? Number.parseFloat(parts[1]) || 0 : 0;
    const isInline = groupName === 'inline' || groupName === 'navigation';

    return { groupName, order, isInline };
}

export class MenuRegistry {
    private readonly _commands = new Map<string, RawCommandContribution>();
    private readonly _menus = new Map<string, RawMenuItemContribution[]>();

    constructor(initialContributes?: PackageJsonContributes) {
        this.registerContributes(initialContributes ?? DEFAULT_PACKAGE_JSON_CONTRIBUTES);
    }

    public registerContributes(contributes: PackageJsonContributes): void {
        if (contributes.commands) {
            for (const cmd of contributes.commands) {
                this._commands.set(cmd.command, cmd);
            }
        }

        if (contributes.menus) {
            for (const [menuId, items] of Object.entries(contributes.menus)) {
                const existing = this._menus.get(menuId) ?? [];
                this._menus.set(menuId, [...existing, ...items]);
            }
        }
    }

    public getCommand(commandId: string): RawCommandContribution | undefined {
        return this._commands.get(commandId);
    }

    public getMenuItems(menuId: string, context: IContextKeyService): ResolvedMenuItem[] {
        const rawItems = this._menus.get(menuId);
        if (!rawItems || rawItems.length === 0) {
            return [];
        }

        const resolved: ResolvedMenuItem[] = [];

        for (const raw of rawItems) {
            if (raw.when && !WhenEvaluator.evaluate(raw.when, context)) {
                continue;
            }

            const cmd = this._commands.get(raw.command);
            const { groupName, order, isInline } = parseMenuGroup(raw.group);
            const title = cmd?.title ?? raw.command;
            const category = cmd?.category;
            const iconClass = resolveIconClass(cmd?.icon);

            resolved.push({
                command: raw.command,
                title,
                category,
                iconClass,
                groupName,
                order,
                isInline,
                when: raw.when,
            });
        }

        // Sort items: group name priority, then order ascending
        resolved.sort((a, b) => {
            if (a.groupName !== b.groupName) {
                return a.groupName.localeCompare(b.groupName);
            }
            return a.order - b.order;
        });

        return resolved;
    }

    public getInlineActions(menuId: string, context: IContextKeyService): ResolvedMenuItem[] {
        const allItems = this.getMenuItems(menuId, context);
        return allItems.filter((item) => item.isInline);
    }

    public getContextActions(menuId: string, context: IContextKeyService): ResolvedMenuItemGroup[] {
        const allItems = this.getMenuItems(menuId, context);
        if (allItems.length === 0) {
            return [];
        }

        const groupsMap = new Map<string, ResolvedMenuItem[]>();
        for (const item of allItems) {
            const list = groupsMap.get(item.groupName) ?? [];
            list.push(item);
            groupsMap.set(item.groupName, list);
        }

        const groups: ResolvedMenuItemGroup[] = [];
        for (const [groupName, items] of groupsMap.entries()) {
            groups.push({
                groupName,
                items,
            });
        }

        groups.sort((a, b) => a.groupName.localeCompare(b.groupName));
        return groups;
    }
}
