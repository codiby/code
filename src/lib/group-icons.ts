import {
  Folder, Code, Bug, Sparkles, Wrench, Rocket, Database, Terminal, Zap, BookOpen, Beaker, Lock,
  Server, Box, Package, GitBranch, GitCommit, GitMerge, GitPullRequest,
  File, FileText, FileCode, Files, FolderOpen,
  AlertCircle, AlertTriangle, CheckCircle, Info,
  Play, Pause, RefreshCw, Settings, Hammer,
  Tag, Hash, Star, Heart, Bookmark, Flag, Pin,
  Mail, MessageCircle, Phone, Send,
  Clock, Calendar, Timer,
  Cloud, Sun, Moon, Flame,
  Smartphone, Monitor, Cpu,
  User, Users,
  Key, Shield,
  Layout, Layers, LayoutGrid,
  BarChart3, Activity, TrendingUp,
  Coffee, Brain, Lightbulb, Camera, Map, Globe, Award, Trophy, Gift,
  Atom, Music, Image, Compass,
  type LucideIcon,
} from 'lucide-react';

/** Twelve favorite icons shown as the quick-pick row in the icon picker. */
export const ICON_MAP_QUICK: Record<string, LucideIcon> = {
  folder: Folder, code: Code, bug: Bug, sparkles: Sparkles,
  wrench: Wrench, rocket: Rocket, database: Database, terminal: Terminal,
  zap: Zap, book: BookOpen, beaker: Beaker, lock: Lock,
};

/** Full searchable icon set. KEYS are persisted (lucide renames won't break
 *  prefs); VALUES are the current lucide components. Includes everything from
 *  ICON_MAP_QUICK. */
export const ICON_MAP: Record<string, LucideIcon> = {
  ...ICON_MAP_QUICK,
  server: Server, box: Box, package: Package,
  'git-branch': GitBranch, 'git-commit': GitCommit, 'git-merge': GitMerge, 'git-pr': GitPullRequest,
  file: File, 'file-text': FileText, 'file-code': FileCode, files: Files, 'folder-open': FolderOpen,
  alert: AlertCircle, warning: AlertTriangle, check: CheckCircle, info: Info,
  play: Play, pause: Pause, refresh: RefreshCw, settings: Settings, hammer: Hammer,
  tag: Tag, hash: Hash, star: Star, heart: Heart, bookmark: Bookmark, flag: Flag, pin: Pin,
  mail: Mail, message: MessageCircle, phone: Phone, send: Send,
  clock: Clock, calendar: Calendar, timer: Timer,
  cloud: Cloud, sun: Sun, moon: Moon, flame: Flame,
  smartphone: Smartphone, monitor: Monitor, cpu: Cpu,
  user: User, users: Users,
  key: Key, shield: Shield,
  layout: Layout, layers: Layers, grid: LayoutGrid,
  chart: BarChart3, activity: Activity, 'trending-up': TrendingUp,
  coffee: Coffee, brain: Brain, lightbulb: Lightbulb, camera: Camera, map: Map, globe: Globe,
  award: Award, trophy: Trophy, gift: Gift, atom: Atom, music: Music, image: Image, compass: Compass,
};
