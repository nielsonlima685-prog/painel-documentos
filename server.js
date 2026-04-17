const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { exec } = require('child_process');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURAÇÕES ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'ch-contas-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Configurar Mercado Pago
const client = new MercadoPagoConfig({
    accessToken: 'APP_USR-6089853392725639-040723-b9b1f076c942da11f2a006271503d5a2-2949958903'
});
const payment = new Payment(client);

// ==================== GERENCIAMENTO DE USUÁRIOS ====================
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

const defaultUsers = [
    { 
        id: 1, 
        user: 'Newbr47', 
        pass: '88837024', 
        role: 'admin', 
        nome: 'Carlos Henrique', 
        plano: 'MASTER PREMIUM', 
        createdAt: new Date().toISOString(), 
        saldo: 100,  // Apenas admin tem saldo inicial
        transacoes: []
    }
];

function loadUserData() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
        return defaultUsers;
    }
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUserData(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ==================== FUNÇÕES DE CARTEIRA ====================
async function debitarSaldo(userId, valor, servico) {
    const users = loadUserData();
    const userIndex = users.findIndex(u => u.id == userId);
    
    if (userIndex === -1) {
        throw new Error('Usuário não encontrado');
    }
    
    const saldoAtual = users[userIndex].saldo || 0;
    
    if (saldoAtual < valor) {
        throw new Error(`Saldo insuficiente. Necessário R$ ${valor.toFixed(2)}`);
    }
    
    users[userIndex].saldo = saldoAtual - valor;
    
    if (!users[userIndex].transacoes) users[userIndex].transacoes = [];
    users[userIndex].transacoes.unshift({
        tipo: 'saida',
        servico: servico,
        valor: valor,
        data: new Date().toISOString(),
        saldo_apos: users[userIndex].saldo
    });
    
    saveUserData(users);
    return true;
}

async function creditarSaldo(userId, valor, descricao) {
    const users = loadUserData();
    const userIndex = users.findIndex(u => u.id == userId);
    
    if (userIndex === -1) {
        throw new Error('Usuário não encontrado');
    }
    
    users[userIndex].saldo = (users[userIndex].saldo || 0) + valor;
    
    if (!users[userIndex].transacoes) users[userIndex].transacoes = [];
    users[userIndex].transacoes.unshift({
        tipo: 'entrada',
        servico: descricao,
        valor: valor,
        data: new Date().toISOString(),
        saldo_apos: users[userIndex].saldo
    });
    
    saveUserData(users);
    return true;
}

// ==================== MIDDLEWARES ====================
const requireAuth = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login.html');
    }
};

const requireAdmin = (req, res, next) => {
    if (req.session.role === 'admin') {
        next();
    } else {
        res.status(403).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <script>
                    alert('⛔ ACESSO NEGADO! Apenas administradores podem acessar esta área.');
                    window.location.href = '/home';
                </script>
            </head>
            <body></body>
            </html>
        `);
    }
};

// ==================== ROTAS PÚBLICAS ====================
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadUserData();
    const usuarioValido = users.find(u => u.user === username && u.pass === password);
    
    if (usuarioValido) {
        req.session.user = usuarioValido.user;
        req.session.nome = usuarioValido.nome;
        req.session.role = usuarioValido.role;
        req.session.plano = usuarioValido.plano;
        req.session.userId = usuarioValido.id;
        res.redirect('/home');
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <script>
                    alert('❌ Acesso negado! Credenciais inválidas.');
                    window.location.href = '/login.html';
                </script>
            </head>
            <body></body>
            </html>
        `);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

// ==================== API DE SESSÃO ====================
app.get('/api/session', requireAuth, (req, res) => {
    const users = loadUserData();
    const user = users.find(u => u.user === req.session.user);
    res.json({
        user: req.session.user,
        nome: req.session.nome,
        role: req.session.role,
        plano: req.session.plano,
        userId: req.session.userId,
        saldo: user?.saldo || 0,
        expira: "08/05/2026 01:48:55"
    });
});

// ==================== API DE CARTEIRA ====================
app.get('/api/saldo', requireAuth, (req, res) => {
    const users = loadUserData();
    const user = users.find(u => u.id === req.session.userId);
    res.json({ saldo: user?.saldo || 0 });
});

app.get('/api/extrato', requireAuth, (req, res) => {
    const users = loadUserData();
    const user = users.find(u => u.id === req.session.userId);
    res.json({ transacoes: user?.transacoes || [] });
});

// Gerar PIX para recarga
app.post('/api/gerar-recarga', requireAuth, async (req, res) => {
    const { valor } = req.body;
    const userId = req.session.userId;
    
    if (!valor || valor < 10) {
        return res.status(400).json({ error: 'Valor mínimo de R$ 10,00' });
    }
    
    try {
        const response = await payment.create({
            body: {
                transaction_amount: Number(valor),
                description: `Recarga de saldo - CH Vendas`,
                payment_method_id: 'pix',
                payer: { email: `${userId}@chvendas.com.br` }
            }
        });
        
        res.json({
            success: true,
            transactionId: response.id,
            qrCode: response.point_of_interaction.transaction_data.qr_code_base64,
            pixCode: response.point_of_interaction.transaction_data.qr_code,
            valor: valor
        });
    } catch (err) {
        console.error('Erro ao gerar PIX:', err);
        res.status(500).json({ error: err.message });
    }
});

// Confirmar recarga
app.post('/api/confirmar-recarga', requireAuth, async (req, res) => {
    const { transactionId, valor } = req.body;
    const userId = req.session.userId;
    
    try {
        const response = await payment.get({ id: transactionId });
        
        if (response.body.status === 'approved') {
            await creditarSaldo(userId, valor, `Recarga de R$ ${valor.toFixed(2)}`);
            const users = loadUserData();
            const user = users.find(u => u.id === userId);
            res.json({ success: true, saldo: user?.saldo || 0 });
        } else {
            res.json({ success: false, status: response.body.status });
        }
    } catch (err) {
        console.error('Erro ao confirmar recarga:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== API CONSULTADOR ====================
app.post('/api/consultar-antecedentes', requireAuth, async (req, res) => {
    const { cpf, nome } = req.body;
    const userId = req.session.userId;
    const valorServico = 10;
    
    if (!cpf && !nome) {
        return res.status(400).json({ error: 'CPF ou Nome é obrigatório' });
    }
    
    try {
        await debitarSaldo(userId, valorServico, 'Consulta de antecedentes');
        
        // Simular consulta (substituir por API real depois)
        const resultado = {
            status: 'aprovado',
            mensagem: '✅ Nada consta na base de dados. Motorista aprovado!',
            processos: []
        };
        
        res.json(resultado);
    } catch (err) {
        if (err.message.includes('Saldo insuficiente')) {
            res.status(400).json({ error: err.message });
        } else {
            res.status(500).json({ error: err.message });
        }
    }
});

// ==================== API DE GERAÇÃO DE PDF ====================
function formatarCpfCnpj(valor) {
    const limpo = valor.replace(/\D/g, '');
    if (limpo.length === 11) {
        return limpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    } else if (limpo.length === 14) {
        return limpo.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
    }
    return valor;
}

app.post('/api/gerar-final', requireAuth, async (req, res) => {
    try {
        const dados = req.body;
        const userId = req.session.userId;
        const valorServico = 40;
        
        await debitarSaldo(userId, valorServico, 'Emissão CRLV');
        
        const tipo = dados.tipo_template || dados.tipo_veiculo || 'carro';
        const templatePDFName = tipo === 'moto' ? 'template_moto.pdf' : 'template_carro.pdf';
        const coordsJSONName = tipo === 'moto' ? 'modelo_moto.template.json' : 'modelo_carro.template.json';
        
        const pdfPath = path.join(__dirname, 'assets', templatePDFName);
        const coordsPath = path.join(__dirname, 'assets', coordsJSONName);

        if (!fs.existsSync(pdfPath)) {
            return res.status(404).send(`Arquivo PDF base não encontrado.`);
        }
        if (!fs.existsSync(coordsPath)) {
            return res.status(404).send(`Template de coordenadas não encontrado.`);
        }

        const existingPdfBytes = fs.readFileSync(pdfPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const firstPage = pdfDoc.getPages()[0];
        const coords = JSON.parse(fs.readFileSync(coordsPath, 'utf8'));

        Object.keys(coords).forEach(key => {
            const pos = coords[key];
            if (pos.x !== undefined && pos.y !== undefined) {
                const w = parseFloat(pos.w || 150);
                const h = parseFloat(pos.h || 12);
                const yOffset = parseFloat(pos.yOffsetRect || -2);

                firstPage.drawRectangle({
                    x: parseFloat(pos.x),
                    y: parseFloat(pos.y) + yOffset,
                    width: w,
                    height: h,
                    color: rgb(1, 1, 1),
                });
            }
        });

        Object.keys(coords).forEach(key => {
            const pos = coords[key];
            let valor = dados[key] || "";

            if (!valor) {
                if (key === 'numero_crv' && dados.num_crv) valor = dados.num_crv;
                if (key === 'cod_seguranca' && dados.codigo_seguranca) valor = dados.codigo_seguranca;
                if (key === 'data' && dados.data_emissao) valor = dados.data_emissao;
            }

            valor = valor.toString().trim().toUpperCase();
            if (key === 'cpf_cnpj') valor = formatarCpfCnpj(valor);
            
            if (pos.x !== undefined && pos.y !== undefined && valor !== "") {
                const x = parseFloat(pos.x);
                const y = parseFloat(pos.y);
                
                let fontSize = 9;
                if (valor.length > 20) fontSize = 8;
                if (valor.length > 30) fontSize = 7;

                firstPage.drawText(valor, {
                    x: x + parseFloat(pos.offX || 0),
                    y: y,
                    size: fontSize,
                    font: fontBold,
                    color: rgb(0, 0, 0),
                });
            }
        });

        const pdfBuffer = await pdfDoc.save();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="CRLV_${dados.placa || 'DOCUMENTO'}.pdf"`);
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        console.error("Erro crítico:", error);
        if (error.message.includes('Saldo insuficiente')) {
            res.status(400).send(error.message);
        } else {
            res.status(500).send("Erro interno ao processar o documento PDF.");
        }
    }
});

// ==================== ADMIN - GERENCIAR USUÁRIOS ====================
app.get('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
    const users = loadUserData();
    const safeUsers = users.map(u => ({ ...u, pass: '********' }));
    res.json(safeUsers);
});

app.post('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
    const { user, pass, role, nome, saldo } = req.body;
    if (!user || !pass) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    const users = loadUserData();
    if (users.find(u => u.user === user)) {
        return res.status(400).json({ error: 'Usuário já existe!' });
    }
    const newUser = {
        id: users.length + 1,
        user: user,
        pass: pass,
        role: role || 'user',
        nome: nome || user,
        plano: role === 'admin' ? 'MASTER PREMIUM' : 'OPERADOR',
        createdAt: new Date().toISOString(),
        saldo: 0,  // NOVOS USUÁRIOS COMEÇAM COM R$ 0
        transacoes: []
    };
    users.push(newUser);
    saveUserData(users);
    res.json({ success: true, user: { ...newUser, pass: '********' } });
});

app.put('/api/usuarios/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { user, pass, role, nome, saldo } = req.body;
    const users = loadUserData();
    const index = users.findIndex(u => u.id == id);
    if (index === -1) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    users[index].user = user || users[index].user;
    if (pass) users[index].pass = pass;
    users[index].role = role || users[index].role;
    users[index].nome = nome || users[index].nome;
    users[index].plano = users[index].role === 'admin' ? 'MASTER PREMIUM' : 'OPERADOR';
    if (saldo !== undefined) users[index].saldo = saldo;
    saveUserData(users);
    res.json({ success: true, user: { ...users[index], pass: '********' } });
});

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const users = loadUserData();
    if (users.find(u => u.id == id && u.user === req.session.user)) {
        return res.status(400).json({ error: 'Você não pode deletar seu próprio usuário!' });
    }
    const filteredUsers = users.filter(u => u.id != id);
    if (filteredUsers.length === users.length) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    saveUserData(filteredUsers);
    res.json({ success: true });
});

// ==================== ADMIN - ESTATÍSTICAS ====================
const BOT_STATS_FILE = path.join(__dirname, 'data', 'bot_stats.json');

if (!fs.existsSync(BOT_STATS_FILE)) {
    fs.writeFileSync(BOT_STATS_FILE, JSON.stringify({ vendas: 0, total_faturado: 0, ultimas_vendas: [] }));
}

app.get('/api/bot/stats', requireAuth, requireAdmin, (req, res) => {
    const stats = JSON.parse(fs.readFileSync(BOT_STATS_FILE, 'utf8'));
    res.json(stats);
});

// ==================== API DE COORDENADAS ====================
app.get('/api/coords', requireAuth, requireAdmin, (req, res) => {
    const tipo = req.query.tipo || 'moto';
    const fileName = tipo === 'carro' ? 'modelo_carro.template.json' : 'modelo_moto.template.json';
    const filePath = path.join(__dirname, 'assets', fileName);
    
    if (fs.existsSync(filePath)) {
        res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } else {
        res.json({});
    }
});

app.post('/api/save-coords', requireAuth, requireAdmin, (req, res) => {
    const tipo = req.query.tipo || 'moto';
    const fileName = tipo === 'carro' ? 'modelo_carro.template.json' : 'modelo_moto.template.json';
    const assetsPath = path.join(__dirname, 'assets');
    
    if (!fs.existsSync(assetsPath)) fs.mkdirSync(assetsPath);
    
    const filePath = path.join(assetsPath, fileName);
    
    try {
        fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send("Erro ao salvar arquivo de coordenadas.");
    }
});

// ==================== ROTAS PROTEGIDAS ====================
app.get('/home', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'home.html'));
});

app.get('/emissao', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'emissao.html'));
});

app.get('/calibrar', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'index.html'));
});

app.get('/usuarios', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'usuarios.html'));
});

app.get('/consultador', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'consultador.html'));
});

app.get('/bot-admin', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'bot-admin.html'));
});

// ==================== LOJA PÚBLICA ====================
app.get('/loja', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loja.html'));
});

// ==================== ROTA RAIZ ====================
app.get('/', (req, res) => {
    if (req.session.user) {
        res.redirect('/home');
    } else {
        res.redirect('/login.html');
    }
});

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 SERVIDOR CH VENDAS`);
    console.log(`${'='.repeat(50)}`);
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`🔑 Admin: Newbr47 / 88837024`);
    console.log(`📄 Emissão CRLV: /emissao (R$ 40,00)`);
    console.log(`🔍 Consultador: /consultador (R$ 10,00)`);
    console.log(`💰 Sistema de carteira: ativo`);
    console.log(`💳 Novos usuários: saldo R$ 0,00`);
    console.log(`${'='.repeat(50)}\n`);
});
