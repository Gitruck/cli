// Generated from gitruck-infra/contracts/subtitle-font-metrics.json. Do not edit.
export const SUBTITLE_FONT_METRICS = {
  "version": 1,
  "family": "思源黑体 CN Bold",
  "aliases": [
    "思源黑体 CN Bold",
    "Source Han Sans CN Bold",
    "SourceHanSansCN-Bold"
  ],
  "file": "sourcehansanscn-bold.otf",
  "sha256": "97e5eff6dd208ccb814726458c8c7ab4b59327c62b9ee8df3440e7e835209ab9",
  "unitsPerEm": 1000,
  "winAscent": 1132,
  "winDescent": 314
} as const;

/** ASS real-dimension size -> CSS em size, for the registered subtitle font only. */
export function subtitleAssFontSizeToCss(size: number): number {
    return size * SUBTITLE_FONT_METRICS.unitsPerEm /
        (SUBTITLE_FONT_METRICS.winAscent + SUBTITLE_FONT_METRICS.winDescent);
}

export function isRegisteredSubtitleFont(family: string): boolean {
    return SUBTITLE_FONT_METRICS.aliases.some(alias => alias.toLowerCase() === family.trim().toLowerCase());
}
