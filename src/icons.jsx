const Icon = ({ d, size = 18, color = "currentColor", sw = 2 }) => (
  React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round", style: { display: "inline-block", verticalAlign: "middle", flexShrink: 0 } },
    typeof d === "string" ? React.createElement("path", { d }) : d)
);

const OrionIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display:"inline-block", verticalAlign:"middle", flexShrink:0, borderRadius:"50%" }}>
    <circle cx="16" cy="16" r="16" fill="#6d28d9"/>
    <path d="M16 8l1.8 5.5h5.7l-4.65 3.4 1.8 5.5L16 19.1l-4.65 3.3 1.8-5.5L8.5 13.5h5.7z" fill="white" opacity="0.95"/>
  </svg>
);

const ICONS = {
  dashboard: (c) => <Icon color={c} d={<>{React.createElement("rect",{x:"3",y:"3",width:"7",height:"7",rx:"1"})}{React.createElement("rect",{x:"14",y:"3",width:"7",height:"4",rx:"1"})}{React.createElement("rect",{x:"3",y:"14",width:"7",height:"4",rx:"1"})}{React.createElement("rect",{x:"14",y:"11",width:"7",height:"7",rx:"1"})}</>} />,
  links: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"})}{React.createElement("path",{d:"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"})}</>} />,
  contacts: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"})}{React.createElement("circle",{cx:"9",cy:"7",r:"4"})}{React.createElement("path",{d:"M22 21v-2a4 4 0 0 0-3-3.87"})}{React.createElement("path",{d:"M16 3.13a4 4 0 0 1 0 7.75"})}</>} />,
  notes: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"})}{React.createElement("polyline",{points:"14 2 14 8 20 8"})}{React.createElement("line",{x1:"16",y1:"13",x2:"8",y2:"13"})}{React.createElement("line",{x1:"16",y1:"17",x2:"8",y2:"17"})}</>} />,
  todos: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M22 11.08V12a10 10 0 1 1-5.93-9.14"})}{React.createElement("polyline",{points:"22 4 12 14.01 9 11.01"})}</>} />,
  chat: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"})}</>} />,
  announcements: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"})}{React.createElement("path",{d:"M13.73 21a2 2 0 0 1-3.46 0"})}</>} />,
  anomalies: (c) => <Icon color={c} d={<>{React.createElement("polyline",{points:"22 12 18 12 15 21 9 3 6 12 2 12"})}</>} />,
  scorecard: (c) => <Icon color={c} d={<>{React.createElement("line",{x1:"18",y1:"20",x2:"18",y2:"10"})}{React.createElement("line",{x1:"12",y1:"20",x2:"12",y2:"4"})}{React.createElement("line",{x1:"6",y1:"20",x2:"6",y2:"14"})}{React.createElement("circle",{cx:"18",cy:"8",r:"2"})}{React.createElement("circle",{cx:"12",cy:"2",r:"2"})}{React.createElement("circle",{cx:"6",cy:"12",r:"2"})}</>} />,
  map: (c) => <Icon color={c} d={<>{React.createElement("polygon",{points:"1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"})}{React.createElement("line",{x1:"8",y1:"2",x2:"8",y2:"18"})}{React.createElement("line",{x1:"16",y1:"6",x2:"16",y2:"22"})}</>} />,
  locations: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"})}{React.createElement("circle",{cx:"12",cy:"10",r:"3"})}</>} />,
  analytics: (c) => <Icon color={c} d={<>{React.createElement("line",{x1:"18",y1:"20",x2:"18",y2:"10"})}{React.createElement("line",{x1:"12",y1:"20",x2:"12",y2:"4"})}{React.createElement("line",{x1:"6",y1:"20",x2:"6",y2:"14"})}</>} />,
  pulse: (c) => <Icon color={c} d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  projects: (c) => <Icon color={c} d={<>{React.createElement("rect",{x:"2",y:"6",width:"20",height:"14",rx:"2"})}{React.createElement("path",{d:"M12 2v4"})}{React.createElement("path",{d:"M2 10h20"})}</>} />,
  users: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"})}{React.createElement("circle",{cx:"9",cy:"7",r:"4"})}{React.createElement("path",{d:"M23 21v-2a4 4 0 0 0-3-3.87"})}{React.createElement("path",{d:"M16 3.13a4 4 0 0 1 0 7.75"})}</>} />,
  settings: (c) => <Icon color={c} d={<>{React.createElement("line",{x1:"4",y1:"21",x2:"4",y2:"14"})}{React.createElement("line",{x1:"4",y1:"10",x2:"4",y2:"3"})}{React.createElement("line",{x1:"12",y1:"21",x2:"12",y2:"12"})}{React.createElement("line",{x1:"12",y1:"8",x2:"12",y2:"3"})}{React.createElement("line",{x1:"20",y1:"21",x2:"20",y2:"16"})}{React.createElement("line",{x1:"20",y1:"12",x2:"20",y2:"3"})}{React.createElement("line",{x1:"1",y1:"14",x2:"7",y2:"14"})}{React.createElement("line",{x1:"9",y1:"8",x2:"15",y2:"8"})}{React.createElement("line",{x1:"17",y1:"16",x2:"23",y2:"16"})}</>} />,
  logout: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"})}{React.createElement("polyline",{points:"16 17 21 12 16 7"})}{React.createElement("line",{x1:"21",y1:"12",x2:"9",y2:"12"})}</>} />,
  search: (c) => <Icon color={c} d={<>{React.createElement("circle",{cx:"11",cy:"11",r:"8"})}{React.createElement("line",{x1:"21",y1:"21",x2:"16.65",y2:"16.65"})}</>} />,
  plus: (c) => <Icon color={c} d={<>{React.createElement("line",{x1:"12",y1:"5",x2:"12",y2:"19"})}{React.createElement("line",{x1:"5",y1:"12",x2:"19",y2:"12"})}</>} />,
  close: (c) => <Icon color={c} d={<>{React.createElement("line",{x1:"18",y1:"6",x2:"6",y2:"18"})}{React.createElement("line",{x1:"6",y1:"6",x2:"18",y2:"18"})}</>} />,
  edit: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M12 20h9"})}{React.createElement("path",{d:"M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"})}</>} />,
  trash: (c) => <Icon color={c} d={<>{React.createElement("polyline",{points:"3 6 5 6 21 6"})}{React.createElement("path",{d:"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"})}</>} />,
  externalLink: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"})}{React.createElement("polyline",{points:"15 3 21 3 21 9"})}{React.createElement("line",{x1:"10",y1:"14",x2:"21",y2:"3"})}</>} />,
  folder: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"})}</>} />,
  bell: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"})}{React.createElement("path",{d:"M13.73 21a2 2 0 0 1-3.46 0"})}</>} />,
  menu: (c) => <Icon color={c} d={<>{React.createElement("line",{x1:"3",y1:"12",x2:"21",y2:"12"})}{React.createElement("line",{x1:"3",y1:"6",x2:"21",y2:"6"})}{React.createElement("line",{x1:"3",y1:"18",x2:"21",y2:"18"})}</>} />,
  sun: (c) => <Icon color={c} d={<>{React.createElement("circle",{cx:"12",cy:"12",r:"5"})}{React.createElement("line",{x1:"12",y1:"1",x2:"12",y2:"3"})}{React.createElement("line",{x1:"12",y1:"21",x2:"12",y2:"23"})}{React.createElement("line",{x1:"4.22",y1:"4.22",x2:"5.64",y2:"5.64"})}{React.createElement("line",{x1:"18.36",y1:"18.36",x2:"19.78",y2:"19.78"})}{React.createElement("line",{x1:"1",y1:"12",x2:"3",y2:"12"})}{React.createElement("line",{x1:"21",y1:"12",x2:"23",y2:"12"})}{React.createElement("line",{x1:"4.22",y1:"19.78",x2:"5.64",y2:"18.36"})}{React.createElement("line",{x1:"18.36",y1:"5.64",x2:"19.78",y2:"4.22"})}</>} />,
  moon: (c) => <Icon color={c} d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  download: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"})}{React.createElement("polyline",{points:"7 10 12 15 17 10"})}{React.createElement("line",{x1:"12",y1:"15",x2:"12",y2:"3"})}</>} />,
  upload: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"})}{React.createElement("polyline",{points:"17 8 12 3 7 8"})}{React.createElement("line",{x1:"12",y1:"3",x2:"12",y2:"15"})}</>} />,
  checkCircle: (c) => <Icon color={c || "#111"} d={<>{React.createElement("path",{d:"M22 11.08V12a10 10 0 1 1-5.93-9.14"})}{React.createElement("polyline",{points:"22 4 12 14.01 9 11.01"})}</>} />,
  xCircle: (c) => <Icon color={c || "#111"} d={<>{React.createElement("circle",{cx:"12",cy:"12",r:"10"})}{React.createElement("line",{x1:"15",y1:"9",x2:"9",y2:"15"})}{React.createElement("line",{x1:"9",y1:"9",x2:"15",y2:"15"})}</>} />,
  profile: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"})}{React.createElement("circle",{cx:"12",cy:"7",r:"4"})}</>} />,
  chevronDown: (c) => <Icon color={c} d="M6 9l6 6 6-6" size={14} />,
  coffee: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M18 8h1a4 4 0 0 1 0 8h-1"})}{React.createElement("path",{d:"M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"})}{React.createElement("line",{x1:"6",y1:"1",x2:"6",y2:"4"})}{React.createElement("line",{x1:"10",y1:"1",x2:"10",y2:"4"})}{React.createElement("line",{x1:"14",y1:"1",x2:"14",y2:"4"})}</>} />,
  briefcase: (c) => <Icon color={c} d={<>{React.createElement("rect",{x:"2",y:"7",width:"20",height:"14",rx:"2",ry:"2"})}{React.createElement("path",{d:"M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"})}</>} />,
  dollar: (c) => <Icon color={c} d={<>{React.createElement("line",{x1:"12",y1:"1",x2:"12",y2:"23"})}{React.createElement("path",{d:"M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"})}</>} />,
  mail: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"})}{React.createElement("polyline",{points:"22,6 12,13 2,6"})}</>} />,
  kb: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M4 19.5A2.5 2.5 0 0 1 6.5 17H20"})}{React.createElement("path",{d:"M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"})}{React.createElement("line",{x1:"8",y1:"7",x2:"16",y2:"7"})}{React.createElement("line",{x1:"8",y1:"11",x2:"14",y2:"11"})}</>} />,
  tickets: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M2 9a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V9z"})}{React.createElement("line",{x1:"9",y1:"4",x2:"9",y2:"20",strokeDasharray:"2 3"})}</>} />,
  calendar: (c) => <Icon color={c} d={<>{React.createElement("rect",{x:"3",y:"4",width:"18",height:"18",rx:"2",ry:"2"})}{React.createElement("line",{x1:"16",y1:"2",x2:"16",y2:"6"})}{React.createElement("line",{x1:"8",y1:"2",x2:"8",y2:"6"})}{React.createElement("line",{x1:"3",y1:"10",x2:"21",y2:"10"})}</>} />,
  reports: (c) => <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  schedule: (c) => <Icon color={c} d={<>{React.createElement("rect",{x:"3",y:"4",width:"18",height:"18",rx:"2"})}{React.createElement("line",{x1:"16",y1:"2",x2:"16",y2:"6"})}{React.createElement("line",{x1:"8",y1:"2",x2:"8",y2:"6"})}{React.createElement("line",{x1:"3",y1:"10",x2:"21",y2:"10"})}{React.createElement("polyline",{points:"8 14 10 17 14 13"})}</>} />,

};

const CAT_ICONS_SVG = {
  "Dunkin'": ICONS.coffee,
  "Payroll & HR": ICONS.briefcase,
  "Operations": ICONS.settings,
  "Finance": ICONS.dollar,
  "Communication": ICONS.mail,
  "Other": ICONS.links,
};

export { Icon, OrionIcon, ICONS, CAT_ICONS_SVG };
