export function ShieldLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="8" fill="#0A1128" />
      <path
        d="M16 5.5c3.2 2.1 6.6 2.6 9 2.7v9.2c0 5.4-3.8 8.6-9 10.6-5.2-2-9-5.2-9-10.6V8.2c2.4-.1 5.8-.6 9-2.7Z"
        fill="#FF8A22"
      />
      <path
        d="M16 8.2v16.4c3.8-1.6 6.4-4 6.4-8.2V10c-2-.2-4.3-.7-6.4-1.8Z"
        fill="#F0F4F8"
        opacity="0.22"
      />
      <path
        d="M16 12.2v8.2M12.6 15.4h6.8"
        stroke="#0A1128"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
