/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { PACKAGE_SETTINGS, type SettingDefinition } from './package-settings.generated';

export type { SettingDefinition };

export const PIERRE_THEMES = [
    'pierre-dark-soft',
    'pierre-dark',
    'pierre-dark-vibrant',
    'pierre-dark-protanopia-deuteranopia',
    'pierre-dark-tritanopia',
    'pierre-light-soft',
    'pierre-light',
    'pierre-light-vibrant',
    'pierre-light-protanopia-deuteranopia',
    'pierre-light-tritanopia',
] as const;

export type PierreTheme = (typeof PIERRE_THEMES)[number];

export const WEB_ADDITIONAL_SETTINGS: readonly SettingDefinition[] = [
    {
        key: 'appearance.theme',
        title: 'Color Theme',
        description: 'Color theme for the standalone web application and diff viewer.',
        category: 'Appearance',
        type: 'string',
        default: 'pierre-dark-soft',
        enum: PIERRE_THEMES,
        enumDescriptions: [
            'Pierre Dark Soft (Recommended - softer contrast canvas)',
            'Pierre Dark (Standard dark theme)',
            'Pierre Dark Vibrant (Vibrant accents)',
            'Pierre Dark Protanopia/Deuteranopia (Red-green accessible)',
            'Pierre Dark Tritanopia (Blue-yellow accessible)',
            'Pierre Light Soft (Softer light theme)',
            'Pierre Light (Standard light theme)',
            'Pierre Light Vibrant (Vibrant light accents)',
            'Pierre Light Protanopia/Deuteranopia (Red-green accessible)',
            'Pierre Light Tritanopia (Blue-yellow accessible)',
        ],
    },
    {
        key: 'diff.style',
        title: 'Default Diff View Style',
        description: 'Default side-by-side or unified presentation when opening diffs.',
        category: 'Diff Viewer',
        type: 'string',
        default: 'split',
        enum: ['split', 'unified'],
        enumDescriptions: ['Side-by-side split presentation', 'Single-column unified presentation'],
    },
];

export const ALL_SETTINGS: readonly SettingDefinition[] = [...WEB_ADDITIONAL_SETTINGS, ...PACKAGE_SETTINGS];

export function getCategories(settings: readonly SettingDefinition[] = ALL_SETTINGS): string[] {
    const categories = new Set<string>();
    for (const s of settings) {
        categories.add(s.category);
    }
    // Return with Appearance first, then General, then others sorted alphabetically
    const order = ['Appearance', 'General', 'Diff Viewer', 'Commit Editor', 'Log Graph', 'Repositories', 'Performance'];
    const result: string[] = [];
    for (const cat of order) {
        if (categories.has(cat)) {
            result.push(cat);
            categories.delete(cat);
        }
    }
    const remaining = Array.from(categories).sort();
    return [...result, ...remaining];
}

export function filterSettings(
    settings: readonly SettingDefinition[],
    searchQuery: string,
    categoryFilter?: string,
): SettingDefinition[] {
    const query = searchQuery.trim().toLowerCase();
    return settings.filter((s) => {
        if (categoryFilter && categoryFilter !== 'All' && s.category !== categoryFilter) {
            return false;
        }
        if (!query) {
            return true;
        }
        return (
            s.key.toLowerCase().includes(query) ||
            s.title.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query)
        );
    });
}
