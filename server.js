const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { exec } = require('child_process');
const mercadopago = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações iniciais
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'ch-contas-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Configurar Mercado Pago
mercadopago.configure({
    access_token: 'APP_USR-6089853392725639-040723-b9b1f076c942da11f2a006271503d5a2-2949958903'
});

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
                    alert('⛔ ACESSO NEGADO! Apenas administradores chefes podem acessar esta área.');
                    window.location.href = '/home';
                </script>
            </head>
            <body></body>
            </html>
        `);
    }
};

// ==================== GERENCIAMENTO DE USUÁRIOS ====================
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

const defaultUsers = [
    { id: 1, user: 'Newbr47', pass: '88837024', role: 'admin', nome: 'Carlos Henrique', plano: 'MASTER PREMIUM', createdAt: new Date().toISOString() },
    { id: 2, user: 'chcontas', pass: 'master2026', role: 'user', nome: 'CH Contas', plano: 'OPERADOR', createdAt: new Date().toISOString() }
];

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
        return defaultUsers;
    }
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// API de usuários
app.get('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
    const users = loadUsers();
    const safeUsers = users.map(u => ({ ...u, pass: '********' }));
    res.json(safeUsers);
});

app.post('/api/usuarios', requireAuth, requireAdmin, (req, res) => {
    const { user, pass, role, nome } = req.body;
    if (!user || !pass) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    const users = loadUsers();
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
        createdAt: new Date().toISOString()
    };
    users.push(newUser);
    saveUsers(users);
    res.json({ success: true, user: { ...newUser, pass: '********' } });
});

app.put('/api/usuarios/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { user, pass, role, nome } = req.body;
    const users = loadUsers();
    const index = users.findIndex(u => u.id == id);
    if (index === -1) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    users[index].user = user || users[index].user;
    if (pass) users[index].pass = pass;
    users[index].role = role || users[index].role;
    users[index].nome = nome || users[index].nome;
    users[index].plano = users[index].role === 'admin' ? 'MASTER PREMIUM' : 'OPERADOR';
    saveUsers(users);
    res.json({ success: true, user: { ...users[index], pass: '********' } });
});

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const users = loadUsers();
    if (users.find(u => u.id == id && u.user === req.session.user)) {
        return res.status(400).json({ error: 'Você não pode deletar seu próprio usuário!' });
    }
    const filteredUsers = users.filter(u => u.id != id);
    if (filteredUsers.length === users.length) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    saveUsers(filteredUsers);
    res.json({ success: true });
});

// ==================== ROTAS PÚBLICAS ====================
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadUsers();
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
    res.json({
        user: req.session.user,
        nome: req.session.nome,
        role: req.session.role,
        plano: req.session.plano,
        userId: req.session.userId,
        expira: "08/05/2026 01:48:55"
    });
});

// ==================== API CONSULTADOR DE ANTECEDENTES (DATAJUD) ====================
app.post('/api/consultar-antecedentes', requireAuth, (req, res) => {
    const { cpf, nome } = req.body;
    
    console.log(`[CONSULTA] CPF: ${cpf}, Nome: ${nome}`);
    
    if (!cpf && !nome) {
        return res.status(400).json({ error: 'CPF ou Nome é obrigatório' });
    }
    
    const pythonScript = path.join(__dirname, 'scripts', 'consulta_datajud_robusto.py');
    
    if (!fs.existsSync(pythonScript)) {
        return res.status(500).json({ error: 'Script de consulta não encontrado' });
    }
    
    const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : '';
    const nomeLimpo = nome ? nome.toUpperCase().trim() : '';
    
    exec(`python "${pythonScript}" "${cpfLimpo}"`, 
        { timeout: 60000 },
        (error, stdout, stderr) => {
            if (error) {
                console.error('Erro no script:', error);
                return res.status(500).json({ 
                    error: 'Erro ao consultar',
                    details: stderr || error.message
                });
            }
            
            const output = stdout.toString();
            console.log('Python output:', output);
            
            let status = 'pendente';
            let mensagem = '';
            
            if (output.includes('APROVADO')) {
                status = 'aprovado';
                mensagem = '✅ Nada consta na base do CNJ. Motorista aprovado!';
            } else if (output.includes('REPROVADO')) {
                status = 'reprovado';
                mensagem = '❌ Processos encontrados. Motorista reprovado.';
            } else {
                status = 'erro';
                mensagem = '⚠️ Erro na consulta. Tente novamente.';
            }
            
            res.json({ 
                status, 
                mensagem, 
                cpf_consultado: cpfLimpo 
            });
        }
    );
});

// ==================== API DO BOT DE BICOS (MERCADO PAGO) ====================

// Arquivo para estatísticas
const BOT_STATS_FILE = path.join(__dirname, 'data', 'bot_stats.json');

if (!fs.existsSync(BOT_STATS_FILE)) {
    fs.writeFileSync(BOT_STATS_FILE, JSON.stringify({ vendas: 0, total_faturado: 0, ultimas_vendas: [] }));
}

// Endpoint para gerar PIX
app.post('/api/bot/gerar-pix', requireAuth, requireAdmin, async (req, res) => {
    const { valor, descricao } = req.body;
    
    try {
        const payment = await mercadopago.payment.create({
            body: {
                transaction_amount: Number(valor),
                description: descricao || 'Compra de bico',
                payment_method_id: 'pix',
                payer: { email: 'cliente@chvendas.com.br' }
            }
        });
        
        res.json({
            id: payment.body.id,
            qr_code: payment.body.point_of_interaction.transaction_data.qr_code_base64,
            copia_cola: payment.body.point_of_interaction.transaction_data.qr_code
        });
    } catch (err) {
        console.error('Erro ao gerar PIX:', err);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint para verificar pagamento
app.get('/api/bot/verificar-pagamento/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const payment = await mercadopago.payment.findById(req.params.id);
        
        // Se pagamento aprovado, atualizar estatísticas
        if (payment.body.status === 'approved') {
            const stats = JSON.parse(fs.readFileSync(BOT_STATS_FILE, 'utf8'));
            stats.vendas++;
            stats.total_faturado += payment.body.transaction_amount;
            stats.ultimas_vendas.unshift({
                id: payment.body.id,
                valor: payment.body.transaction_amount,
                data: new Date().toISOString(),
                status: 'approved'
            });
            stats.ultimas_vendas = stats.ultimas_vendas.slice(0, 20);
            fs.writeFileSync(BOT_STATS_FILE, JSON.stringify(stats, null, 2));
        }
        
        res.json({ status: payment.body.status });
    } catch (err) {
        console.error('Erro ao verificar pagamento:', err);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint para estatísticas do bot
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

app.get('/bicos', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'bicos.html'));
});

app.get('/bot-admin', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'private', 'bot-admin.html'));
});

// ==================== ROTA DE GERAÇÃO DE PDF ====================
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
        const tipo = dados.tipo_template || dados.tipo_veiculo || 'carro';
        
        const templatePDFName = tipo === 'moto' ? 'template_moto.pdf' : 'template_carro.pdf';
        const coordsJSONName = tipo === 'moto' ? 'modelo_moto.template.json' : 'modelo_carro.template.json';
        
        const pdfPath = path.join(__dirname, 'assets', templatePDFName);
        const coordsPath = path.join(__dirname, 'assets', coordsJSONName);

        if (!fs.existsSync(pdfPath)) {
            return res.status(404).send(`Arquivo PDF base (${templatePDFName}) não encontrado.`);
        }
        if (!fs.existsSync(coordsPath)) {
            return res.status(404).send(`Template de coordenadas (${coordsJSONName}) não encontrado.`);
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
        res.status(500).send("Erro interno ao processar o documento PDF.");
    }
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
app.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 SERVIDOR CH VENDAS`);
    console.log(`${'='.repeat(50)}`);
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`🔑 Admin: Newbr47 / 88837024`);
    console.log(`📄 Emissão CRLV: /emissao`);
    console.log(`🔍 Consultador: /consultador`);
    console.log(`👥 Usuários: /usuarios`);
    console.log(`🤖 Bot de Bicos: /bicos`);
    console.log(`💰 Admin Bot: /bot-admin`);
    console.log(`${'='.repeat(50)}\n`);
});