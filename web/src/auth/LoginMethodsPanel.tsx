export type LoginMethod = {
  id: string;
  name: string;
  enabled: boolean;
};

const methods: LoginMethod[] = [
  { id: 'phone', name: '手机号登录', enabled: true },
  { id: 'email', name: '邮箱登录', enabled: true },
  { id: 'wechat', name: '微信登录', enabled: false },
  { id: 'qq', name: 'QQ 登录', enabled: false },
  { id: 'google', name: 'Google 登录', enabled: false },
];

export default function LoginMethodsPanel() {
  return (
    <section aria-label="login methods">
      {methods.map((method) => (
        <div key={method.id}>
          <strong>{method.name}</strong>
          <span>{method.enabled ? '已启用' : '待配置'}</span>
        </div>
      ))}
    </section>
  );
}
