import {Children, isValidElement, type ReactElement, type ReactNode} from 'react';
import {describe, expect, it} from 'vitest';

import Home from './page';

function findByClassName(node: ReactNode, className: string): ReactElement | undefined {
  if (!isValidElement(node)) return undefined;
  if ((node.props as {className?: string}).className === className) return node;

  let match: ReactElement | undefined;
  Children.forEach((node.props as {children?: ReactNode}).children, (child) => {
    match ??= findByClassName(child, className);
  });
  return match;
}

describe('Home', () => {
  it('starts the family-film creation flow from the primary call to action', () => {
    const callToAction = findByClassName(Home(), 'cta');

    expect(callToAction).toBeDefined();
    expect((callToAction?.props as {href?: string}).href).toBe('/projects/new');
  });
});
