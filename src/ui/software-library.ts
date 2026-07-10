export type SoftwareFeatureStatus = "available" | "foundation" | "planned";

export interface SoftwareFeatureDefinition {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly pageId: string;
  readonly targetId: string;
  readonly status: SoftwareFeatureStatus;
  readonly purpose: string;
  readonly useWhen: string;
  readonly currentCapability: string;
  readonly limitation: string;
  readonly extensionPoints: readonly string[];
}

export interface SoftwareLibraryCallbacks {
  readonly onOpenFeature: (pageId: string, targetId: string) => void;
  readonly onStartTour: () => void;
}

export interface SoftwareLibrary {
  readonly element: HTMLElement;
  readonly selectedFeatureId: string;
  select(featureId: string): void;
  destroy(): void;
}

export const SOFTWARE_FEATURES: readonly SoftwareFeatureDefinition[] = Object.freeze([
  feature("dashboard", "文件", "Dashboard", "dashboard", "dashboard", "available", {
    purpose: "集中浏览本机算法条目，并进入项目、沙箱或测试工作流。",
    useWhen: "开始新任务、继续旧条目或检查最近修改时。",
    currentCapability: "启动或刷新时从 Documents 专属目录列出条目；支持新建、筛选和打开。",
    limitation: "首版不提供删除、重命名和跨设备同步。",
    extensionPoints: ["工作区条目类型", "元数据索引", "最近使用策略"],
  }),
  feature("projects", "文件", "项目", "dashboard", "project", "foundation", {
    purpose: "承载持续演进的算法设计与课程项目。",
    useWhen: "一个问题需要长期维护、测试和后续多文件扩展时。",
    currentCapability: "每个项目使用独立目录、entry.json 与 main.c，修改自动原子保存。",
    limitation: "当前编辑面仍以单一 main.c 为事实源。",
    extensionPoints: ["多文件源码", "课程元数据", "版本与复盘"],
  }),
  feature("sandboxes", "文件", "沙箱", "dashboard", "sandbox", "available", {
    purpose: "保存快速实验，同时避免临时代码散落。",
    useWhen: "验证 C 语法、数据结构片段或算法想法时。",
    currentCapability: "与项目使用相同的安全落盘和自动保存链路。",
    limitation: "尚未提供一键升级为项目。",
    extensionPoints: ["模板", "一键转项目", "实验快照"],
  }),
  feature("tests", "文件", "测试", "dashboard", "test", "foundation", {
    purpose: "为算法输入、期望输出和边界条件建立独立入口。",
    useWhen: "需要设计用例或复现失败输入时。",
    currentCapability: "已具备专属 Documents 条目与现有编译运行底座。",
    limitation: "结构化用例编辑器和项目关联仍在扩展阶段。",
    extensionPoints: ["输入输出用例", "项目关联", "批量回归"],
  }),
  feature("presets", "构建", "预制积木", "build", "preset-blocks", "available", {
    purpose: "提供按学习阶段组织的常见 C 语句和控制结构。",
    useWhen: "初学者希望直接拼接，或快速调用稳定片段时。",
    currentCapability: "支持阶段筛选、搜索、真实拖拽和选中位置插入。",
    limitation: "不兼容的结构位置会被拒绝，不做猜测性修复。",
    extensionPoints: ["学习阶段", "算法元素注册", "课程包"],
  }),
  feature("assembly", "构建", "组装画布", "build", "assembly-canvas", "available", {
    purpose: "用紧凑工业模块呈现 C 结构，并作为真实拖拽目标。",
    useWhen: "搭建、阅读或调整算法控制流时。",
    currentCapability: "保留嵌套层级、受控插槽、选中状态与无损源码映射。",
    limitation: "不支持会破坏语义边界的任意跨层拖动。",
    extensionPoints: ["新语句类型", "高层算法模块", "结构验证器"],
  }),
  feature("source", "构建", "C 代码与同步", "build", "code-pane", "available", {
    purpose: "随时查看和直接编辑积木背后的精确 C 源码。",
    useWhen: "需要精确语法控制、粘贴代码或核对生成结果时。",
    currentCapability: "代码、积木和解析结果即时同步；托管条目在 300 ms 防抖后写入 Documents。",
    limitation: "解析恢复期间会保守暂停结构化写操作。",
    extensionPoints: ["多文件编辑器", "诊断标注", "格式策略"],
  }),
  feature("explanation", "检查", "解释", "explanation", "explanation", "available", {
    purpose: "解释选中语法、符号及其确定性含义。",
    useWhen: "不理解代码块作用、变量来源或库函数时。",
    currentCapability: "节点、符号与内建知识驱动；离线也可使用。",
    limitation: "当前不把自然语言推测当作程序事实。",
    extensionPoints: ["确定性分析事实", "本地 AI 导师", "课程提示"],
  }),
  feature("editing", "检查", "结构编辑", "edit", "edit", "available", {
    purpose: "通过受约束表单安全修改字面量、运算符、语句和局部变量。",
    useWhen: "希望调整程序但不想手工处理全部语法细节时。",
    currentCapability: "语义敏感操作先展示精确 diff，确认后可撤销或重做。",
    limitation: "有歧义、宏或可疑解析时宁可拒绝。",
    extensionPoints: ["新补丁操作", "编辑等价验证", "批量重构"],
  }),
  feature("run", "执行", "编译与运行", "run", "run", "available", {
    purpose: "在本机受控运行器中编译 C 并查看诊断和输出。",
    useWhen: "验证算法结果或检查编译错误时。",
    currentCapability: "具备资源上限、可信确认、输出与终止状态。",
    limitation: "它不是任意不可信代码的强安全沙箱。",
    extensionPoints: ["结构化测试", "工具链诊断", "执行轨迹"],
  }),
  feature(
    "block-library",
    "扩展",
    "积木管理",
    "block-library",
    "block-library-create",
    "available",
    {
      purpose: "把常用 C 片段保存为可复用积木并管理其生命周期。",
      useWhen: "同类片段反复出现，或要建立个人课程积木库时。",
      currentCapability: "支持创建、验证、弃用、恢复和退休；已生成源码不受退休影响。",
      limitation: "积木定义目前保存在本机浏览器存储。",
      extensionPoints: ["积木包导入导出", "版本迁移", "团队目录"],
    },
  ),
  feature("storage", "扩展", "本地存储与安全", "build", "local-save", "available", {
    purpose: "明确源码何时写入磁盘，以及哪些权限没有暴露给界面。",
    useWhen: "核对保存状态、冲突或数据位置时。",
    currentCapability:
      "renderer 只持 opaque ID；主进程验证并原子写入，revision 冲突须确认后重载磁盘版本。",
    limitation: "首版不监听外部编辑器的实时反向变化。",
    extensionPoints: ["冲突解决", "备份恢复", "导出与迁移"],
  }),
  feature(
    "extensions",
    "扩展",
    "平台扩展接口",
    "software-library",
    "software-library",
    "foundation",
    {
      purpose: "说明新页面、命令、算法元素和教学能力如何接入平台。",
      useWhen: "设计新的算法模块、课程包或分析工具时。",
      currentCapability: "工作台注册表已分离 Dock 页面、检查器、命令和算法元素元数据。",
      limitation: "第三方包安装、签名与权限模型尚未开放。",
      extensionPoints: ["Dock 页面", "命令", "算法元素", "检查器", "学习阶段", "运行器能力"],
    },
  ),
]);

export function createSoftwareLibrary(
  host: HTMLElement,
  callbacks: SoftwareLibraryCallbacks,
): SoftwareLibrary {
  assertCallbacks(callbacks);
  const ownerDocument = host.ownerDocument;
  const root = ownerDocument.createElement("section");
  root.className = "software-library-view";
  root.dataset.tourTarget = "software-library-content";
  root.setAttribute("aria-label", "软件功能 Library");

  const index = ownerDocument.createElement("nav");
  index.className = "software-library__index";
  index.setAttribute("aria-label", "功能目录");
  const search = ownerDocument.createElement("input");
  search.type = "search";
  search.className = "software-library__search";
  search.placeholder = "筛选功能";
  search.setAttribute("aria-label", "筛选软件功能");
  const list = ownerDocument.createElement("div");
  list.className = "software-library__list";
  index.append(search, list);

  const detail = ownerDocument.createElement("article");
  detail.className = "software-library__detail";
  detail.setAttribute("aria-live", "polite");
  root.append(index, detail);
  host.append(root);

  let selectedFeatureId = SOFTWARE_FEATURES[0]?.id ?? "";
  let destroyed = false;
  let featureButtons: HTMLButtonElement[] = [];

  const select = (featureId: string): void => {
    assertActive(destroyed);
    const selected = SOFTWARE_FEATURES.find((feature) => feature.id === featureId);
    if (selected === undefined) throw new RangeError(`未知 Library 功能：${featureId}`);
    selectedFeatureId = featureId;
    renderDetail(ownerDocument, detail, selected, callbacks);
    for (const button of featureButtons) {
      const active = button.dataset.featureId === selectedFeatureId;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    }
  };

  const renderIndex = (): void => {
    const query = search.value.trim().toLocaleLowerCase("zh-Hans-CN");
    const visible = SOFTWARE_FEATURES.filter((feature) =>
      `${feature.category} ${feature.title} ${feature.purpose}`
        .toLocaleLowerCase("zh-Hans-CN")
        .includes(query),
    );
    featureButtons = visible.map((feature) => {
      const button = ownerDocument.createElement("button");
      button.className = "software-library__feature";
      button.type = "button";
      button.dataset.featureId = feature.id;
      const category = ownerDocument.createElement("span");
      category.textContent = feature.category;
      const title = ownerDocument.createElement("strong");
      title.textContent = feature.title;
      button.append(category, title);
      button.addEventListener("click", () => select(feature.id));
      return button;
    });
    list.replaceChildren(...featureButtons);
    const nextSelection = visible.some((feature) => feature.id === selectedFeatureId)
      ? selectedFeatureId
      : visible[0]?.id;
    if (nextSelection !== undefined) select(nextSelection);
    else renderEmptyDetail(ownerDocument, detail);
  };

  const onSearch = (): void => renderIndex();
  search.addEventListener("input", onSearch);
  renderIndex();

  return Object.freeze({
    element: root,
    get selectedFeatureId(): string {
      return selectedFeatureId;
    },
    select,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      search.removeEventListener("input", onSearch);
      featureButtons = [];
      root.remove();
    },
  });
}

function renderDetail(
  ownerDocument: Document,
  host: HTMLElement,
  featureDefinition: SoftwareFeatureDefinition,
  callbacks: SoftwareLibraryCallbacks,
): void {
  const header = ownerDocument.createElement("header");
  const heading = ownerDocument.createElement("h2");
  heading.textContent = featureDefinition.title;
  const status = ownerDocument.createElement("span");
  status.className = "software-library__feature-status";
  status.dataset.status = featureDefinition.status;
  status.textContent = statusLabel(featureDefinition.status);
  header.append(heading, status);
  const body = ownerDocument.createElement("dl");
  body.append(
    detailRow(ownerDocument, "作用", featureDefinition.purpose),
    detailRow(ownerDocument, "何时使用", featureDefinition.useWhen),
    detailRow(ownerDocument, "当前能力", featureDefinition.currentCapability),
    detailRow(ownerDocument, "边界", featureDefinition.limitation),
    detailRow(ownerDocument, "扩展点", featureDefinition.extensionPoints.join(" · ")),
  );
  const actions = ownerDocument.createElement("footer");
  const open = textButton(ownerDocument, "打开此功能", "button button--primary");
  open.addEventListener("click", () =>
    callbacks.onOpenFeature(featureDefinition.pageId, featureDefinition.targetId),
  );
  const tour = textButton(ownerDocument, "重新开始视觉引导", "button button--quiet");
  tour.addEventListener("click", callbacks.onStartTour);
  actions.append(open, tour);
  host.replaceChildren(header, body, actions);
}

function renderEmptyDetail(ownerDocument: Document, host: HTMLElement): void {
  const empty = ownerDocument.createElement("p");
  empty.className = "software-library__empty";
  empty.textContent = "没有匹配的功能。";
  host.replaceChildren(empty);
}

function detailRow(ownerDocument: Document, term: string, copy: string): HTMLDivElement {
  const row = ownerDocument.createElement("div");
  const title = ownerDocument.createElement("dt");
  title.textContent = term;
  const description = ownerDocument.createElement("dd");
  description.textContent = copy;
  row.append(title, description);
  return row;
}

function feature(
  id: string,
  category: string,
  title: string,
  pageId: string,
  targetId: string,
  status: SoftwareFeatureStatus,
  content: Pick<
    SoftwareFeatureDefinition,
    "purpose" | "useWhen" | "currentCapability" | "limitation" | "extensionPoints"
  >,
): SoftwareFeatureDefinition {
  return Object.freeze({
    id,
    category,
    title,
    pageId,
    targetId,
    status,
    ...content,
    extensionPoints: Object.freeze([...content.extensionPoints]),
  });
}

function statusLabel(status: SoftwareFeatureStatus): string {
  if (status === "available") return "已实现";
  if (status === "foundation") return "扩展地基";
  return "规划";
}

function textButton(ownerDocument: Document, label: string, className: string): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  return button;
}

function assertCallbacks(callbacks: SoftwareLibraryCallbacks): void {
  if (
    typeof callbacks.onOpenFeature !== "function" ||
    typeof callbacks.onStartTour !== "function"
  ) {
    throw new TypeError("Software Library callbacks 无效");
  }
}

function assertActive(destroyed: boolean): void {
  if (destroyed) throw new Error("Software Library 已销毁");
}
