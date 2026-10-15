# press_bridge

Pont entre un site **WordPress** et une application **Node.js** : press_bridge reçoit les notifications de publication envoyées par WordPress (webhooks), télécharge le HTML rendu de chaque page ou article, le garde en cache sur disque et peut le conserver en mémoire pour le servir sans repasser par WordPress.

```
 WordPress ──(webhook add/update/remove)──▶ middleware ─▶ controllers ─▶ Bridge
                                                                         │
     ▲                                                                   │ GET {target.url}/{slug}
     └───────────────────────────────────────────────────────────────────┘
                                                                         │
                                          {DIR}/metadata.json  ◀─────────┤
                                          {DIR}/contents/<type>/<uuid>.html
                                          mémoire (bridge.data)  ◀───────┘
```

## Fonctionnalités

- Registre local des contenus WordPress (`metadata.json`), indexé par type puis par identifiant WordPress.
- Cache disque du HTML rendu des contenus publiés (`status: "published"`), écrit de façon atomique (fichier temporaire puis `rename`).
- Mise en mémoire facultative par type de contenu (`types_to_buffer`, par défaut les pages), rechargée automatiquement au démarrage.
- Lecture par identifiant ou par slug : `get_by_id(type, id)`, `get_by_slug(type, slug)`.
- Événements (`bridge.on(...)`) à chaque étape : `initialized`, `registered`, `updated`, `removed`, `cache_updated`, `destroyed`.
- Middleware et contrôleurs prêts à brancher sur des routes Express.
- Arrêt propre : `destroy()` attend les opérations en cours avant de fermer le registre.

## Prérequis

- Node.js 18 ou plus récent (utilise `fs/promises` et `crypto.randomUUID()`).
- Un serveur HTTP de type Express capable de parser du JSON (`express.json()`).
- Un site WordPress capable d'envoyer une requête HTTP à la création, la modification et la suppression d'un contenu (hooks `save_post` / `delete_post`, ou une extension de webhooks).

## Installation

Le paquet n'est pas publié sur npm. Installez-le depuis GitHub :

```bash
npm install github:encephalux/node_press_bridge
```

ou depuis un clone local :

```bash
git clone https://github.com/encephalux/node_press_bridge.git
npm install ./node_press_bridge
```

Puis, dans votre application :

```js
const press_bridge = require("node_press_bridge");
```

## Démarrage rapide

```js
const express = require("express");
const press_bridge = require("node_press_bridge");

// 1. Répertoire de travail (par défaut : `${process.cwd()}/press_bridge`).
//    À définir avant de créer le Bridge ; il est créé s'il n'existe pas.
press_bridge.env.DIR = "/var/lib/mon_app/press_bridge";

// 2. Création et initialisation du pont.
const bridge = new press_bridge.Bridge({
    target: {url: "https://blog.example.com"},
    options: {
        post_types: ["page", "post"],
        types_to_buffer: ["page"]
    }
});

(async () => {
    await bridge.init(); // recharge aussi les pages publiées en mémoire

    const mw = press_bridge.middleware(bridge);
    const ctrl = press_bridge.controllers(bridge);

    const app = express();
    app.use(express.json());

    // 3. Routes appelées par WordPress.
    app.post("/press_bridge/add", mw.add, ctrl.add);
    app.post("/press_bridge/update", mw.update, ctrl.update);
    app.post("/press_bridge/remove", mw.remove, ctrl.remove);

    // 4. Service des contenus.
    const serve = post_type => async (req, res) => {
        try {
            const {content} = await bridge.get_by_slug(post_type, req.params.slug);
            res.type("html").send(content);
        } catch(err) {
            res.sendStatus(err.message === "POST_NOT_FOUND" ? 404 : 500);
        }
    };

    app.get("/blog/:slug", serve("post"));
    app.get("/:slug", serve("page"));

    const server = app.listen(3000);

    // 5. Arrêt propre.
    process.on("SIGTERM", async () => {
        server.close();
        await bridge.destroy();
        process.exit(0);
    });
})();
```

## Documentation

| Document | Contenu |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Fonctionnement interne, stockage sur disque, cycle de vie d'un contenu |
| [docs/api.md](docs/api.md) | Référence de l'API : `Bridge`, `middleware`, `controllers`, `env`, `utils` |
| [docs/webhooks.md](docs/webhooks.md) | Format des requêtes attendues et exemple d'intégration côté WordPress |

## Tests

```bash
npm test
```

Les tests utilisent le runner intégré à Node (`node:test`) et ne nécessitent aucune dépendance supplémentaire. Ils démarrent un faux serveur WordPress local et travaillent dans des répertoires temporaires.

| Fichier | Portée |
|---|---|
| `test/MetadataFile.test.js` | Création, lecture et réécriture de `metadata.json` |
| `test/Bridge.test.js` | Enregistrement, mise à jour, suppression, lecture, cache, mémoire, redémarrage, destruction, événements |
| `test/http.test.js` | Validation du middleware (dont le format de l'`id`) et ordre d'exécution des contrôleurs |

## Licence

Distribué sous licence [Apache 2.0](LICENSE).
