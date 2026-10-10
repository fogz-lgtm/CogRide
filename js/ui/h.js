// Preact + htm: JSX-like templates with no build step.
import { h, render, Fragment, createRef } from '../../vendor/preact/preact.module.js';
import htm from '../../vendor/preact/htm.module.js';

export { h, render, Fragment, createRef };
export { useState, useEffect, useRef, useMemo, useCallback, useReducer, useLayoutEffect } from '../../vendor/preact/hooks.module.js';
export const html = htm.bind(h);
