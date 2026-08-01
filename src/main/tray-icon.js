'use strict';

/**
 * Tray icon, inlined as a data URL.
 *
 * Kept as source rather than a binary asset so the repo stays text-only and the
 * icon survives packaging without an extraResources rule. It is a 32x32 RGBA
 * PNG: a brass espresso cup, matching the machine the HUD is bolted to.
 * Regenerate with `python scripts/make-icons.py`, which prints this string and
 * also writes assets/screen-buddy.ico for the desktop shortcut.
 */
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABVklEQVR42u2WO2rEMBCGfQQfwUfQEXQE16lcptwyRQp1qYIgRdrNDQTbbkCkCKRTlTS7INgL6AjODBmBEFpiKZadwgMfSGM9fs0IjZtms/9sj/e3LcCvfOP4vebmHeCAEWCRKBP7awgQgI1PCf1dyl9DwI4i0IebQXtI+WvlX1OoXXgXoL0nP9IvcRkVikn4UYipvXlHAtQVf3UBPgUs8tuU/892eX8eAO056ScT9j1fR2kTfhWsoYB8cefXBw2MpeAa9k1K3/883PEsAR8vNxoYc4XH86A9YB+wqwggnyIRbC0BkgTwNVLQYvgBt3gKMOS0OZ5eFC2UlbefeTYQsKc1ZFNwkp4mm4w5guaoIPxd8WMU3F4xYSyjsQ43nuU1pBM4L+IXDI2btyoGqZiCqlKIKLx8AnX/jhYxqFwiVfUKwUrY5gpwwDgjLFdAC/CZ6JrNNpto37Vcc/2+TRZpAAAAAElFTkSuQmCC';

module.exports = { TRAY_ICON_DATA_URL };
