// The Waveroom mark: an amber lamp with one wave through it.
// Same drawing as app/icon.svg (the favicon), kept inline so it inherits nothing.
export default function Logo({ size = 22 }) {
  return (
    <svg
      className="logo"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="16" cy="16" r="15" fill="#f2a93b" />
      <path
        d="M6 16c2.2-6 4.4-6 6.6 0s4.4 6 6.6 0 4.4-6 6.8 0"
        fill="none"
        stroke="#241a15"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
