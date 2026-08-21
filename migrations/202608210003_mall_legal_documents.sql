-- Marketplace-owned public legal documents. Content is editable by the marketplace owner and
-- versioned independently so a registration can record exactly what it accepted.

CREATE TABLE IF NOT EXISTS mall_legal_documents (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('terms', 'privacy')),
    content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 100000),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, kind)
);

CREATE TABLE IF NOT EXISTS user_legal_acceptances (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    terms_version bigint NOT NULL CHECK (terms_version > 0),
    privacy_version bigint NOT NULL CHECK (privacy_version > 0),
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, user_id, terms_version, privacy_version)
);

CREATE INDEX IF NOT EXISTS user_legal_acceptances_user_idx
    ON user_legal_acceptances (user_id, accepted_at DESC);

ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS "legalTermsVersion" bigint CHECK ("legalTermsVersion" IS NULL OR "legalTermsVersion" > 0),
    ADD COLUMN IF NOT EXISTS "legalPrivacyVersion" bigint CHECK ("legalPrivacyVersion" IS NULL OR "legalPrivacyVersion" > 0);

INSERT INTO mall_legal_documents (tenant_id, kind, content)
SELECT id, 'terms', $$# 用户协议

生效日期：以本页面显示的更新时间为准。

1. 服务说明
{{mall_name}} 提供商品浏览、店铺检索、撮合与相关服务。商品的展示、价格、库存和履约信息由对应店铺负责。

2. 账号使用
请使用真实、合法的信息注册和使用账号，并妥善保管登录凭据。不得利用本服务从事违法、侵权、欺诈或干扰平台正常运行的行为。

3. 商品与交易
下单、联系店铺或线下成交前，请自行核实商品信息和交易条件。除法律另有规定外，具体交易由用户与店铺按照双方确认的条件完成。

4. 平台规则
我们可以为保障安全、合规和服务质量，对违规内容、账号或店铺采取必要措施，并会在适用法律要求的范围内告知你。

5. 联系我们
如对本协议有疑问，请通过商城公开的联系方式与我们联系。$$
FROM tenants
ON CONFLICT (tenant_id, kind) DO NOTHING;

INSERT INTO mall_legal_documents (tenant_id, kind, content)
SELECT id, 'privacy', $$# 隐私政策

生效日期：以本页面显示的更新时间为准。

1. 我们收集的信息
为了提供账号、商品浏览、联系撮合和安全保障服务，{{mall_name}} 可能处理你的账号资料、设备与访问记录，以及你主动提交的商品或沟通信息。

2. 信息的使用
我们仅在提供、维护和改进服务，保障交易安全，履行法定义务以及取得你同意的范围内使用这些信息。

3. 信息的共享
我们不会公开你的联系方式。只有在你和对方均明确同意、或法律法规要求时，才会按相应流程提供必要信息。

4. 信息安全
我们采取合理的技术和管理措施保护信息安全。请勿向他人泄露密码、验证码或其他登录凭据。

5. 你的权利
你可以在账号页面更新个人资料、管理登录方式和会话；也可以通过商城公开的联系方式咨询、更正或删除相关信息。

6. 政策更新
本政策更新后会在此页面公布；重大变化会以适当方式提示。$$
FROM tenants
ON CONFLICT (tenant_id, kind) DO NOTHING;
