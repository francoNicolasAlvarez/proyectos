import { useEffect, useMemo, useRef, useState } from 'react';
import type { Product } from '../api/types';
import { selectionProblems, unitPrice, type Selections } from '../lib/cart';
import { delta, money } from '../lib/money';

interface Props {
  product: Product;
  onClose: () => void;
  onAdd: (selections: Selections, quantity: number) => void;
}

/** Hoja inferior para elegir opciones y cantidad de un producto. */
export function ProductSheet({ product, onClose, onAdd }: Props) {
  const [selections, setSelections] = useState<Selections>(() => {
    // Los grupos de elección única y obligatoria no se preseleccionan: el cliente decide.
    return {};
  });
  const [quantity, setQuantity] = useState(1);
  const [submitted, setSubmitted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const problems = useMemo(() => selectionProblems(product.groups, selections), [product.groups, selections]);
  const total = unitPrice(product, selections) * quantity;

  const toggle = (gid: string, oid: string, single: boolean, max: number) => {
    setSelections((cur) => {
      const now = cur[gid] ?? [];
      if (single) return { ...cur, [gid]: [oid] };
      if (now.includes(oid)) return { ...cur, [gid]: now.filter((x) => x !== oid) };
      if (now.length >= max) return cur;
      return { ...cur, [gid]: [...now, oid] };
    });
  };

  const submit = () => {
    setSubmitted(true);
    if (problems.length > 0) return;
    onAdd(selections, quantity);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet enter" role="dialog" aria-modal="true" aria-label={product.name} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="grabber" aria-hidden="true" />
        <h2>{product.name}</h2>
        {product.description && <p className="muted">{product.description}</p>}
        {product.ingredients && <p className="muted small">Ingredientes: {product.ingredients}</p>}

        {product.groups.map((g) => {
          const single = g.max === 1;
          const problem = submitted ? problems.find((p) => p.groupId === g.id) : undefined;
          return (
            <fieldset key={g.id} className="group" aria-describedby={problem ? `err-${g.id}` : undefined}>
              <legend>{g.name} <span className="muted small">{g.min > 0 ? '(obligatorio)' : '(opcional)'}{!single ? ` · hasta ${g.max}` : ''}</span></legend>
              {g.options.map((o) => {
                const checked = (selections[g.id] ?? []).includes(o.id);
                return (
                  <label key={o.id} className={`opt${checked ? ' on' : ''}${o.available ? '' : ' off'}`}>
                    <input type={single ? 'radio' : 'checkbox'} name={g.id} checked={checked} disabled={!o.available}
                      onChange={() => toggle(g.id, o.id, single, g.max)} />
                    <span>{o.name}{o.available ? '' : ' (agotado)'}</span>
                    <span className="muted">{delta(o.priceDeltaCents)}</span>
                  </label>
                );
              })}
              {problem && <p id={`err-${g.id}`} role="alert" className="field-error">{problem.message}</p>}
            </fieldset>
          );
        })}

        <div className="qty-row">
          <div className="qty" role="group" aria-label="Cantidad">
            <button type="button" aria-label="Quitar uno" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>−</button>
            <output aria-live="polite">{quantity}</output>
            <button type="button" aria-label="Agregar uno" onClick={() => setQuantity((q) => Math.min(50, q + 1))}>+</button>
          </div>
          <button type="button" className="btn primary grow" onClick={submit}>Agregar · {money(total)}</button>
        </div>
        <button type="button" className="btn link" onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}
