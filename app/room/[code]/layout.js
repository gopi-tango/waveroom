// Tab title carries the room code so several open rooms are easy to tell apart.
export function generateMetadata({ params }) {
  const code = String(params.code || "").toUpperCase();
  return { title: `Room ${code} – Waveroom` };
}

export default function RoomLayout({ children }) {
  return children;
}
