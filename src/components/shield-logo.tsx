export function ShieldLogo({ className }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt="Albany Watch"
      width={180}
      height={180}
      className={className}
      draggable={false}
    />
  );
}
