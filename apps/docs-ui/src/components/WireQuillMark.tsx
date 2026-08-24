/**
 * The WireQuill mark (spec sections 20 to 22).
 *
 * A wire carrying traffic, lifting into a stroke of ink and ending in a nib.
 * That is the product in one shape: what goes over the wire becomes what is
 * written down.
 *
 * Inline rather than an `<img>`, for three reasons: no second request, no flash
 * before it paints, and it inherits `currentColor`, so it is legible in the top
 * bar and would survive a light theme unchanged.
 */
export function WireQuillMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      // Decorative: the word "WireQuill" is right next to it, so announcing the
      // mark as well would be saying the name twice (spec section 42).
      aria-hidden="true"
      focusable="false"
      data-testid="wirequill-mark"
    >
      <circle cx="3" cy="16.5" r="1.6" fill="currentColor" />
      <path d="M4.6 16.5H10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path
        d="M10 16.5C14.2 16.5 16.6 12.4 18.4 7.2"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M17.5 8.6 22.2 2l-1.6 8.1z" fill="currentColor" />
    </svg>
  );
}
