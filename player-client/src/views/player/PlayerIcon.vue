<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.tasks" />
  </svg>
</template>
<script setup lang="ts">
  defineProps<{ name: string }>()
  const paths: Record<string, string> = {
    lobby: 'M3 10 12 3l9 7M5 9v12h14V9M9 21v-7h6v7',
    tasks: 'M8 4H5v17h14V4h-3M8 3h8v4H8zM8 12h8M8 16h5',
    rank: 'M8 4h8v6a4 4 0 0 1-8 0V4ZM8 6H4v3a4 4 0 0 0 4 4M16 6h4v3a4 4 0 0 1-4 4M12 14v5M8 21h8M9 19h6',
    me: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
    back: 'm15 5-7 7 7 7',
    next: 'm9 5 7 7-7 7',
    wallet: 'M3 6h17v15H3V6ZM3 6V3h14v3M16 11h5v5h-5z',
    receipt: 'M5 3h14v18l-3-2-4 2-4-2-3 2V3ZM8 7h8M8 11h8M8 15h5',
    shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3ZM9 12l2 2 4-4',
    qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM21 14v3M17 21h4v-4M14 21v-3',
    settings:
      'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z',
    lock: 'M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3M12 14v3',
    logout: 'M9 4H4v16h5M10 12h11m-4-4 4 4-4 4',
    refresh: 'M20 7v5h-5M4 17v-5h5M20 11a8 8 0 0 0-14-5M4 13a8 8 0 0 0 14 5',
    plus: 'M12 5v14M5 12h14',
    image: 'M3 3h18v18H3zM3 16l6-6 4 4 3-3 5 5M16 7h.01',
    check: 'm5 12 4 4L19 6',
    close: 'm6 6 12 12M6 18 18 6',
    search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5',
    announcement: 'M3 9h4l11-5v16L7 15H3V9ZM7 15l2 6h4l-2-4M21 8v8',
    game: 'M7 7h10a4 4 0 0 1 3.9 3.1l1 5a3.4 3.4 0 0 1-5.7 3.1L14 16h-4l-2.2 2.2a3.4 3.4 0 0 1-5.7-3.1l1-5A4 4 0 0 1 7 7ZM6 12h4M8 10v4M16 11h.01M18 13h.01M9 7l1-3h4l1 3',
    empty: 'M4 8h16v13H4zM4 8l4-5h8l4 5M8 13h8',
    offline: 'M3 3l18 18M5 8a15 15 0 0 1 15 1M8 12a9 9 0 0 1 9 1M11 17h2'
  }
</script>
