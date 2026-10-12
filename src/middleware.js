module.exports = bridge => {
    function check_fields(body) {
        return (body.id && /^[1-9]\d*$/.test(String(body.id)))
            && body.post_type
            && bridge.options.post_types.includes(body.post_type)
            && (body.slug === "" || body.slug)
            && body.title
            && body.date
            && body.author
            && (body.thumbnail === "" || body.thumbnail)
            && (body.post_type === "page" ||  body.excerpt === "" || body.excerpt)
            && body.status;
    }

    function build_data_waggon(req, body) {
        req.data_waggon = Object.assign(req.data_waggon || {}, {
            post_type: body.post_type,
            id: String(body.id),
            slug: body.slug,
            title: body.title,
            date: body.date,
            author: body.author,
            thumbnail: body.thumbnail,
            status: body.status
        });

        if(body.post_type !== "page")
            req.data_waggon.excerpt = body.excerpt;
    }

    const add = (req, res, next) => {
        if(!check_fields(req.body)) return res.end();
        build_data_waggon(req, req.body);
        next();
    };

    const update = (req, res, next) => {
        // { Check fields }
        if(!check_fields(req.body)) return res.end();
        build_data_waggon(req, req.body);
        next();
    };

    const remove = (req, res, next) => {
        // { Check fields }
        if(!req.body.id || !req.body.post_type) return res.end();

        req.data_waggon = Object.assign(req.data_waggon || {}, {
            post_type: req.body.post_type,
            id: req.body.id
        });

        next();
    };

    return {
        add,
        update,
        remove
    };
};
