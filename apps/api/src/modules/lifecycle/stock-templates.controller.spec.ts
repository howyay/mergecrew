import { NotFoundException } from '@nestjs/common';
import { StockTemplateController } from './stock-templates.controller.js';

const controller = new StockTemplateController();

describe('StockTemplateController', () => {
  it('lists every stock template with the formula it exports to', () => {
    const { items } = controller.list();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.formula).toBe(`mol-mc-${item.id}`);
      expect(typeof item.name).toBe('string');
    }
    expect(items.map((i) => i.id)).toContain('generic-careful');
  });

  it('reports the formula and the step chain on the detail route', () => {
    const detail = controller.detail('generic-careful');
    expect(detail.formula).toBe('mol-mc-generic-careful');
    expect(detail.compiler).toMatch(/^>=/);
    expect(detail.steps.length).toBeGreaterThan(1);
    expect(detail.steps[0]?.needs).toEqual([]);
    expect(detail.steps[detail.steps.length - 1]?.id).toBe('land');
    // sourceYaml and parsed stay on the detail route only.
    expect(detail.sourceYaml).toContain('lifecycle');
    expect(detail.parsed).toBeTruthy();
  });

  it('keeps the step chain linear', () => {
    const { steps } = controller.detail('nextjs-vercel');
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]?.needs).toEqual([steps[i - 1]?.id]);
    }
  });

  it('throws for an unknown template', () => {
    expect(() => controller.detail('nope')).toThrow(NotFoundException);
  });
});
