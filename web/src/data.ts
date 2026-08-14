import type { ActivityItem, GatewaySummary, VehicleListing } from "./types";

export const recommendations: VehicleListing[] = [
  {
    id: "listing-001",
    title: "2023 极氪 001 WE",
    subtitle: "双电机 · 100 kWh · 首任车主",
    price: "¥238,800",
    monthly: "约 ¥4,180/月",
    mileage: "2.1 万公里",
    location: "上海 · 浦东",
    energy: "纯电",
    year: "2023",
    matchScore: 96,
    accent: "cactus",
    reasons: ["续航符合你的通勤半径", "预算内保留 1.1 万整备空间", "同城可在周末看车"],
    trust: ["维保记录完整", "无重大事故", "支持第三方检测"],
    seller: "林先生",
    response: "通常 12 分钟内回复",
  },
  {
    id: "listing-002",
    title: "2022 宝马 330Li M",
    subtitle: "曜夜套装 · 一手车 · 原版原漆",
    price: "¥226,000",
    monthly: "约 ¥3,960/月",
    mileage: "3.4 万公里",
    location: "苏州 · 工业园",
    energy: "汽油",
    year: "2022",
    matchScore: 91,
    accent: "heather",
    reasons: ["驾驶偏好高度匹配", "里程低于你的上限", "卖家接受第三方复检"],
    trust: ["4S 店维保", "车况已复核", "可协商过户日期"],
    seller: "周女士",
    response: "通常 28 分钟内回复",
  },
  {
    id: "listing-003",
    title: "2024 理想 L7 Pro",
    subtitle: "家庭六座 · 智驾版 · 准新车",
    price: "¥289,900",
    monthly: "约 ¥5,070/月",
    mileage: "0.9 万公里",
    location: "杭州 · 余杭",
    energy: "增程",
    year: "2024",
    matchScore: 88,
    accent: "clay",
    reasons: ["空间满足家庭出行", "安全配置覆盖你的必选项", "车龄与里程均优于筛选条件"],
    trust: ["官方质保期内", "支持底盘检测", "手续齐全"],
    seller: "陈先生",
    response: "通常 1 小时内回复",
  },
];

export const gateways: GatewaySummary[] = [
  { name: "微信支付", kind: "API v3", methods: "Native · JSAPI · H5", status: "healthy" },
  { name: "支付宝", kind: "OpenAPI", methods: "电脑网站 · 手机网站", status: "healthy" },
  { name: "EPay", kind: "标准协议", methods: "托管收银台 · 查询 · 退款", status: "healthy" },
  { name: "Waffo Pancake", kind: "聚合网关", methods: "预授权 · 捕获 · 退款", status: "attention" },
  { name: "线下成交", kind: "撮合流程", methods: "当面验车 · 双方确认 · 平台提成", status: "reserved" },
];

export const sellerActivity: ActivityItem[] = [
  { title: "买家查看了完整车况", detail: "来自“30 万内家庭用车”需求", time: "刚刚", tone: "success" },
  { title: "新增一位高意向买家", detail: "匹配度 94%，愿意本周末看车", time: "18 分钟前", tone: "success" },
  { title: "建议补充底盘照片", detail: "完整度提升后预计增加 12% 有效曝光", time: "2 小时前", tone: "warning" },
];

export const paymentActivity: ActivityItem[] = [
  { title: "线下成交提成已捕获", detail: "MP-20260814-0942 · ¥2,400.00", time: "11:42", tone: "success" },
  { title: "部分退款已完成", detail: "EPay · ¥120.00 · 红字更正待开具", time: "10:18", tone: "warning" },
  { title: "发票已交付", detail: "平台服务费电子发票 · 微信支付", time: "09:36", tone: "neutral" },
];
