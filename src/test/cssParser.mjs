import postcss from 'postcss';

/** Parse flat rules inside layers/conditionals without losing their ancestry.
 * Keyframe steps are not element selectors and are deliberately excluded.
 */
export function parseCss(css) {
  const rules = [];
  postcss.parse(css).walkRules((rule) => {
    const context = [];
    for (let parent = rule.parent; parent?.type !== 'root'; parent = parent.parent) {
      if (parent.type === 'atrule') {
        if (parent.name.endsWith('keyframes')) return;
        context.unshift(`@${parent.name} ${parent.params}`);
      }
    }
    rules.push({ selector: rule.selector.trim(), body: rule.nodes.map((node) => node.toString()).join('; ') + ';', context });
  });
  return rules;
}

/** Default lookup excludes conditional overrides; pass context to inspect them. */
export function declarationsFor(css, selector, context = []) {
  const normalize = (value) => value.replace(/\s+/g, ' ').trim();
  const rule = parseCss(css).find((rule) => normalize(rule.selector) === normalize(selector)
    && JSON.stringify(rule.context.filter((part) => !part.startsWith('@layer '))) === JSON.stringify(context));
  if (!rule) throw new Error(`Missing CSS rule for ${selector} in ${context.join(' / ') || 'unconditional context'}`);
  return rule.body;
}
