# ADR 0009：TimescaleDB 和 pgvector 图像

- 状态：已接受
- 日期：2026-08-14

## 决定

本地开发使用固定的 TimescaleDB 和 pgvector 构建显式 PostgreSQL 映像
组件并在启动时验证两个扩展。规范事件和账本表保持正常
PostgreSQL 表使全局唯一 ID 保持可执行。时间尺度超表保持可重建
市场观察，其唯一索引包括时间分区列。
