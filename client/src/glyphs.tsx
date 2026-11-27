export function AxisMotif() {
  return (
    <svg className="ax-axis-motif" data-part="axis" width="8" height="64" viewBox="0 0 8 64"
      aria-hidden="true" focusable="false">
      <path d="M1 0V64M1 24H7" fill="none" stroke="currentColor" strokeWidth="1"
        strokeLinecap="square" strokeLinejoin="miter" shapeRendering="crispEdges" />
    </svg>
  );
}

export function ChevronGlyph({ direction }: { direction: "right" | "down" }) {
  return (
    <svg className="ax-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d={direction === "right" ? "M4.5 2.5L8 6L4.5 9.5" : "M2.5 4.5L6 8L9.5 4.5"}
        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

export function AxisMark() {
  return (
    <svg className="ax-mark" width="10" height="20" viewBox="0 0 10 20" aria-hidden="true" focusable="false">
      <rect x="8" y="0" width="2" height="20" fill="currentColor" />
      <rect x="0" y="7" width="8" height="2" fill="currentColor" />
    </svg>
  );
}

export function BinderGlyph() {
  return (
    <svg className="ax-glyph" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M6 3V17M6 6H15M6 10H15M6 14H15" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

export function OverflowGlyph() {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" focusable="false">
    <rect x="3" y="9" width="2" height="2" />
    <rect x="9" y="9" width="2" height="2" />
    <rect x="15" y="9" width="2" height="2" />
  </svg>;
}
