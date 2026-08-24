export function ShieldLogo({ className }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt=""
      width={180}
      height={180}
      className={className}
      draggable={false}
    />
  );
}
