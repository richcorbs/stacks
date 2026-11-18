import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { renderToStaticMarkup } from 'react-dom/server';

/* Render components against the real stylesheet and read the winning authored
 * declaration. jsdom supplies DOM matching and layout defaults; this helper
 * supplies specificity/order, custom properties, and color-mix because jsdom's
 * cascade stops at source order and its CSSOM drops some modern values. */
const stylesheet = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const ruleCache = new Map();

/** Flatten @layer wrappers so the cascade order is the authored source order. */
function flattenLayers(root) {
  root.walkAtRules('import', (rule) => rule.remove());
  let layer;
  while ((layer = root.nodes.find((node) => node.type === 'atrule' && node.name === 'layer'))) {
    if (layer.nodes) layer.replaceWith(...layer.nodes);
    else layer.remove();
  }
}

function topLevelComma(value) {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') depth -= 1;
    else if (value[index] === ',' && depth === 0) return index;
  }
  return -1;
}

/** Resolve var() references without parsing rule structure. */
export function resolveVars(value, variables, seen = new Set()) {
  let result = '';
  for (let index = 0; index < value.length;) {
    const start = value.indexOf('var(', index);
    if (start === -1) return result + value.slice(index);
    result += value.slice(index, start);
    let cursor = start + 4;
    let depth = 1;
    while (cursor < value.length && depth > 0) {
      if (value[cursor] === '(') depth += 1;
      else if (value[cursor] === ')') depth -= 1;
      cursor += 1;
    }
    const inner = value.slice(start + 4, cursor - 1);
    const comma = topLevelComma(inner);
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    if (seen.has(name)) {
      result += fallback ?? `var(${inner})`;
    } else if (variables[name] !== undefined) {
      result += resolveVars(variables[name], variables, new Set([...seen, name]));
    } else if (fallback !== undefined) {
      result += resolveVars(fallback, variables, seen);
    } else {
      result += `var(${inner})`;
    }
    index = cursor;
  }
  return result;
}

function resolveCalcs(value) {
  let current = value;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = current.replace(/calc\(([^()]+)\)/gi, (whole, expression) => {
      const terms = expression.split(/\s*([+-])\s*/).filter(Boolean);
      if (terms.length === 1) return terms[0].trim();
      let total = 0;
      let sign = 1;
      for (const term of terms) {
        if (term === '+') sign = 1;
        else if (term === '-') sign = -1;
        else if (/^-?\d*\.?\d+px$/.test(term.trim())) total += sign * Number.parseFloat(term);
        else return whole;
      }
      return `${total}px`;
    });
    if (next === current) return current;
    current = next;
  }
  return current;
}

function normalizeValue(value) {
  return resolveCalcs(value).replace(/(^|\s)\.(\d)/g, '$10.$2').replace(/\s+/g, ' ').trim();
}

function cssProperty(property) {
  return property.startsWith('--') ? property : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function normalizeSelector(selector) {
  return selector.replace(/\s+/g, ' ').trim();
}

function variableDeclarations(root, includeOwnerTokens) {
  const variables = { '--ui-font-delta': '0px' };
  const candidates = [];
  root.walkRules((rule) => {
    const selector = normalizeSelector(rule.selector);
    const owner = selector.startsWith('.kanbanDetail.cardWorkspace[data-project-color]');
    if (selector !== ':root' && selector !== '[data-project-color]' && !(includeOwnerTokens && owner)) return;
    for (const node of rule.nodes) {
      if (node.type === 'decl' && node.prop.startsWith('--')) candidates.push([node.prop, node.value]);
    }
  });
  const store = () => {
    for (const [name, value] of candidates) {
      if (name === '--project-accent') continue;
      variables[name] = resolveVars(value, variables);
    }
  };
  store();
  return { variables, store };
}

function parseRules(projectAccent) {
  const key = projectAccent ?? '';
  if (ruleCache.has(key)) return ruleCache.get(key);
  const root = postcss.parse(stylesheet);
  flattenLayers(root);
  const { variables, store } = variableDeclarations(root, Boolean(projectAccent));
  if (projectAccent) variables['--project-accent'] = projectAccent;
  for (let pass = 0; pass < 8; pass += 1) store();

  const rules = [];
  const walk = (node, media = null) => {
    for (const child of node.nodes ?? []) {
      if (child.type === 'rule') {
        rules.push({
          selector: normalizeSelector(child.selector),
          media,
          declarations: child.nodes.filter((entry) => entry.type === 'decl').map((entry) => ({
            name: entry.prop,
            value: normalizeValue(resolveVars(entry.value, variables)),
            important: Boolean(entry.important),
          })),
        });
      } else if (child.type === 'atrule' && child.name === 'media') {
        walk(child, child.params);
      }
    }
  };
  walk(root);
  ruleCache.set(key, rules);
  return rules;
}

function parseColor(value) {
  const text = value.trim();
  const hex = text.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (hex) {
    const channels = hex.length <= 4 ? hex.slice(0, 3).split('').map((channel) => channel + channel) : hex.slice(0, 6).match(/../g);
    return { r: Number.parseInt(channels[0], 16), g: Number.parseInt(channels[1], 16), b: Number.parseInt(channels[2], 16), a: hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1 };
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  return null;
}

function colorMix(value) {
  const open = value.indexOf('color-mix(');
  if (open === -1) return null;
  let cursor = open + 'color-mix('.length;
  let depth = 1;
  while (cursor < value.length && depth > 0) {
    if (value[cursor] === '(') depth += 1;
    else if (value[cursor] === ')') depth -= 1;
    cursor += 1;
  }
  const args = value.slice(open + 'color-mix('.length, cursor - 1);
  const parts = [];
  let start = 0;
  let nested = 0;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '(') nested += 1;
    else if (args[index] === ')') nested -= 1;
    else if (args[index] === ',' && nested === 0) {
      parts.push(args.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(args.slice(start).trim());
  if (parts.length < 3) return null;
  const colors = parts.slice(1).map((part) => {
    const match = part.match(/^(.*?)\s+([\d.]+)%$/);
    return match ? { color: parseColor(match[1]) ?? colorMix(match[1]), weight: Number(match[2]) } : { color: parseColor(part) ?? colorMix(part), weight: null };
  });
  if (colors.some((entry) => !entry.color)) return null;
  const total = colors.reduce((sum, entry) => sum + entry.weight, 0);
  const weights = colors.map((entry) => entry.weight ?? ((100 - total) / (colors.length - (total ? 0 : 1))));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (!weightSum) return null;
  const blend = (channel) => Math.round(colors.reduce((sum, entry, index) => sum + entry.color[channel] * weights[index], 0) / weightSum);
  return { r: blend('r'), g: blend('g'), b: blend('b'), a: colors.reduce((sum, entry, index) => sum + entry.color.a * weights[index], 0) / weightSum };
}

export function parseCssColor(value) {
  return parseColor(value) ?? colorMix(value);
}

export function color(value) {
  const parsed = parseCssColor(String(value));
  return parsed ? `rgb(${parsed.r}, ${parsed.g}, ${parsed.b})` : String(value).trim();
}

export function channelSpread(value) {
  const parsed = parseCssColor(String(value));
  if (!parsed) return Number.POSITIVE_INFINITY;
  return Math.max(parsed.r, parsed.g, parsed.b) - Math.min(parsed.r, parsed.g, parsed.b);
}

export function isNeutral(value) {
  const parsed = parseCssColor(String(value));
  if (!parsed) return false;
  return parsed.r === parsed.g && parsed.g === parsed.b;
}

export function isTransparent(value) {
  const parsed = parseCssColor(String(value));
  return parsed ? parsed.a === 0 : /\btransparent\b/.test(String(value));
}

function splitSelectorList(selector) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < selector.length; index += 1) {
    if (selector[index] === '(' || selector[index] === '[') depth += 1;
    else if (selector[index] === ')' || selector[index] === ']') depth -= 1;
    else if (selector[index] === ',' && depth === 0) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter(Boolean);
}

function closingParen(value, start) {
  let depth = 1;
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') {
      depth -= 1;
      if (!depth) return index;
    }
  }
  return value.length - 1;
}

/** Specificity is used only to pick the winning declaration in the test helper. */
export function specificity(selector) {
  const counts = [0, 0, 0];
  const add = (other) => { counts[0] += other[0]; counts[1] += other[1]; counts[2] += other[2]; };
  for (let index = 0; index < selector.length;) {
    const character = selector[index];
    if (character === '#' || character === '.') {
      counts[character === '#' ? 0 : 1] += 1;
      index += 1;
      while (index < selector.length && /[\w-]/.test(selector[index])) index += 1;
    } else if (character === '[') {
      counts[1] += 1;
      index += 1;
      while (index < selector.length && selector[index] !== ']') index += 1;
      index += 1;
    } else if (character === ':') {
      if (selector[index + 1] === ':') {
        counts[2] += 1;
        index += 2;
        while (index < selector.length && /[\w-]/.test(selector[index])) index += 1;
        if (selector[index] === '(') index = closingParen(selector, index) + 1;
        continue;
      }
      let end = index + 1;
      while (end < selector.length && /[\w-]/.test(selector[end])) end += 1;
      const name = selector.slice(index + 1, end).toLowerCase();
      if (selector[end] === '(') {
        const close = closingParen(selector, end);
        const inner = selector.slice(end + 1, close);
        if (name === 'is' || name === 'not' || name === 'has') {
          const innerCounts = [0, 0, 0];
          for (const part of splitSelectorList(inner)) {
            const candidate = specificity(part);
            if (candidate[0] > innerCounts[0]
              || (candidate[0] === innerCounts[0] && candidate[1] > innerCounts[1])
              || (candidate[0] === innerCounts[0] && candidate[1] === innerCounts[1] && candidate[2] > innerCounts[2])) innerCounts.splice(0, 3, ...candidate);
          }
          add(innerCounts);
        } else if (name !== 'where') {
          counts[1] += 1;
        }
        index = close + 1;
      } else {
        if (name !== 'where') counts[1] += 1;
        index = end;
      }
    } else if (character === '*') {
      index += 1;
    } else if (/[\w-]/.test(character)) {
      counts[2] += 1;
      while (index < selector.length && /[\w-]/.test(selector[index])) index += 1;
    } else {
      index += 1;
    }
  }
  return counts;
}

function mediaMatches(window, condition) {
  if (!condition) return true;
  if (/prefers-reduced-motion/.test(condition)) return false;
  for (const match of condition.matchAll(/\((max|min)-width:\s*(\d+)px\)/g)) {
    const width = window.innerWidth;
    if (match[1] === 'max' && width > Number(match[2])) return false;
    if (match[1] === 'min' && width < Number(match[2])) return false;
  }
  return true;
}

function compareSpecificity(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.spec[index] !== right.spec[index]) return left.spec[index] - right.spec[index];
  }
  return left.order - right.order;
}

function longhand(declaration, property, temp) {
  if (declaration.name === property) return declaration.value;
  if (property.startsWith('--')) return undefined;
  temp.style.cssText = '';
  temp.style.setProperty(declaration.name, declaration.value);
  const expanded = temp.style.getPropertyValue(property);
  return expanded || undefined;
}

function winningValue(element, property, temp, window, rules) {
  const candidates = [];
  let order = 0;
  for (const rule of rules) {
    if (!mediaMatches(window, rule.media)) continue;
    for (const selector of splitSelectorList(rule.selector)) {
      let matches = false;
      try { matches = element.matches(selector); } catch { matches = false; }
      if (!matches) continue;
      const spec = specificity(selector);
      for (const declaration of rule.declarations) {
        const value = longhand(declaration, property, temp);
        if (value === undefined) continue;
        candidates.push({ value, important: declaration.important, spec, order: order++ });
      }
    }
  }
  if (!candidates.length) return undefined;
  candidates.sort((left, right) => {
    if (left.important !== right.important) return left.important ? 1 : -1;
    return compareSpecificity(left, right);
  });
  return candidates.at(-1).value;
}

function rulesForSelector(rules, selector) {
  const wanted = normalizeSelector(selector);
  return rules.filter((rule) => rule.selector === wanted);
}

/** Render a component or markup and compute styles through the authored cascade. */
export function renderToStyle(component, { projectAccent = null, html = '' } = {}) {
  const markup = typeof component === 'string' ? component : renderToStaticMarkup(component);
  const dom = new JSDOM(`<div id="root">${markup}${html}</div>`);
  const { window } = dom;
  const { document } = window;
  const rules = parseRules(projectAccent);
  const root = document.getElementById('root');
  const temp = document.createElement('div');
  const customProperty = (element, name) => {
    for (let current = element; current; current = current.parentElement) {
      const value = winningValue(current, name, temp, window, rules);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const computedValue = (element, property) => {
    const direct = winningValue(element, cssProperty(property), temp, window, rules);
    if (direct === undefined) return undefined;
    if (direct === 'inherit') return element.parentElement ? computedValue(element.parentElement, property) : undefined;
    if (direct === 'currentColor') return computedValue(element, 'color');
    if (direct.includes('var(')) {
      return resolveVars(direct, new Proxy({}, { get: (_target, name) => typeof name === 'string' ? customProperty(element, name) : undefined }));
    }
    return direct;
  };
  const style = (selector, property) => {
    const element = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!element) throw new Error(`Missing element ${selector}`);
    const computed = computedValue(element, property);
    if (computed !== undefined) return normalizeValue(computed);
    return normalizeValue(window.getComputedStyle(element).getPropertyValue(cssProperty(property)));
  };
  const colorOf = (selector, property = 'color') => color(style(selector, property));
  const spreadOf = (selector, property = 'backgroundColor') => channelSpread(style(selector, property));
  const declaration = (selector, property) => {
    const found = rulesForSelector(rules, selector);
    if (!found.length) throw new Error(`Missing CSS rule for ${selector}`);
    const wanted = cssProperty(property);
    for (const rule of [...found].reverse()) {
      const match = [...rule.declarations].reverse().find((entry) => entry.name === wanted);
      if (match) return normalizeValue(match.value);
    }
    return '';
  };
  const rule = (selector) => {
    const found = rulesForSelector(rules, selector).at(-1);
    if (!found) return undefined;
    return {
      selectorText: found.selector,
      style: {
        getPropertyValue: (property) => found.declarations.find((entry) => entry.name === cssProperty(property))?.value ?? '',
        getPropertyPriority: (property) => found.declarations.find((entry) => entry.name === cssProperty(property))?.important ? 'important' : '',
      },
    };
  };
  const token = (name) => {
    let value = '';
    for (const rule of rules) {
      for (const entry of rule.declarations) {
        if (entry.name === name) value = entry.value;
      }
    }
    return value;
  };
  return { dom, window, document, root, style, colorOf, spreadOf, rule, declaration, token };
}

/** Read one authored declaration without computing it (for jsdom-unsupported values). */
export function authoredDeclaration(selector, property, projectAccent = null) {
  const found = rulesForSelector(parseRules(projectAccent), selector);
  if (!found.length) throw new Error(`Missing CSS rule for ${selector}`);
  const wanted = cssProperty(property);
  for (const rule of [...found].reverse()) {
    const match = [...rule.declarations].reverse().find((entry) => entry.name === wanted);
    if (match) return normalizeValue(match.value);
  }
  return '';
}

/** All authored rules with media context, without a DOM. */
export function cssom(projectAccent = null) {
  return parseRules(projectAccent).map((rule) => ({
    selector: rule.selector,
    context: rule.media ? [rule.media] : [],
    declarations: {
      getPropertyValue: (property) => rule.declarations.find((entry) => entry.name === cssProperty(property))?.value ?? '',
    },
  }));
}

export function declarationFromCssom(selector, property, { context = [], projectAccent = null } = {}) {
  const found = cssom(projectAccent).filter((entry) => normalizeSelector(entry.selector) === normalizeSelector(selector)
    && JSON.stringify(entry.context) === JSON.stringify(context));
  if (!found.length) throw new Error(`Missing CSS rule for ${selector}`);
  return normalizeValue(found.at(-1).declarations.getPropertyValue(property));
}
