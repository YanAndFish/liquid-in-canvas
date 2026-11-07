export const ICONS = {
  play: 'M8 5l11 7-11 7V5Z',
  pause: 'M9 5v14M15 5v14',
  adjust: 'M4 7h8M16 7h4M4 17h3M11 17h9M12 4v6M7 14v6',
  bag: 'M6.5 8h11l-.9 12.5h-9.2L6.5 8Zm3.2 0V6a2.3 2.3 0 0 1 4.6 0v2',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M4.5 12.5 9.5 18 19.5 6.5',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  trash: 'M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 13h9.2l.9-13M10 11v5M14 11v5',
  sun: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z',
} as const

export type IconName = keyof typeof ICONS
